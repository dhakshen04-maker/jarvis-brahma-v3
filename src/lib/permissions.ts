/**
 * Central permission manager.
 *
 * - Every capability has a fixed risk class (LOW / MEDIUM / HIGH / CRITICAL) defined in code.
 * - Users grant or revoke capabilities (only actor "user" may change grants).
 * - HIGH and CRITICAL operations additionally need a single-use, time-limited approval bound to the
 *   exact tool + arguments. CRITICAL approvals require typing CONFIRM.
 * - CORE_POLICY is frozen code: no API, agent or evolution routine can modify it.
 */
import { db } from "@/db";
import { approvals, permissionGrants } from "@/db/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import { audit } from "@/lib/log";
import { sha256, stableStringify } from "@/lib/util";

export type Risk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface CapabilityDef {
  id: string;
  label: string;
  risk: Risk;
  defaultGranted: boolean;
  description: string;
}

export const CAPABILITIES: CapabilityDef[] = [
  { id: "chat.basic", label: "Conversation", risk: "LOW", defaultGranted: true, description: "Answer questions and hold conversations." },
  { id: "memory.read", label: "Read memory", risk: "LOW", defaultGranted: true, description: "Search and retrieve stored memories." },
  { id: "memory.write", label: "Write memory", risk: "MEDIUM", defaultGranted: true, description: "Store memories when you ask (remember ...)." },
  { id: "memory.delete", label: "Delete memory", risk: "HIGH", defaultGranted: true, description: "Delete memories (each deletion from chat needs approval)." },
  { id: "skill.execute", label: "Run skills", risk: "LOW", defaultGranted: true, description: "Execute skills inside the isolated sandbox." },
  { id: "skill.create", label: "Create skills", risk: "MEDIUM", defaultGranted: true, description: "Draft, develop and test new skills." },
  { id: "skill.manage", label: "Manage skills", risk: "MEDIUM", defaultGranted: true, description: "Promote, roll back, enable or disable skills." },
  { id: "research.web", label: "Web research", risk: "MEDIUM", defaultGranted: true, description: "Fetch public web pages (private networks are always blocked)." },
  { id: "agents.run", label: "Run agent teams", risk: "MEDIUM", defaultGranted: true, description: "Delegate tasks to the multi-agent system." },
  { id: "system.read", label: "Read system info", risk: "LOW", defaultGranted: true, description: "CPU, memory, OS information." },
  { id: "process.list", label: "List processes", risk: "MEDIUM", defaultGranted: true, description: "List running processes." },
  { id: "process.kill", label: "Terminate processes", risk: "CRITICAL", defaultGranted: false, description: "Terminate a process (destructive)." },
  { id: "fs.read", label: "Read workspace files", risk: "LOW", defaultGranted: true, description: "List, read and search files inside the workspace boundary." },
  { id: "fs.write", label: "Write workspace files", risk: "MEDIUM", defaultGranted: true, description: "Create folders and files inside the workspace boundary." },
  { id: "fs.delete", label: "Delete workspace files", risk: "HIGH", defaultGranted: true, description: "Delete files (moved to a recoverable trash folder)." },
  { id: "script.run", label: "Run workspace scripts", risk: "HIGH", defaultGranted: false, description: "Execute scripts from workspace/scripts with a timeout." },
  { id: "app.open", label: "Open applications", risk: "MEDIUM", defaultGranted: false, description: "Launch allow-listed desktop applications." },
  { id: "device.command", label: "Command paired devices", risk: "MEDIUM", defaultGranted: false, description: "Queue commands for paired Android devices." },
  { id: "evolution.apply", label: "Apply evolution suggestions", risk: "HIGH", defaultGranted: true, description: "Apply user-approved improvement suggestions (never security policy)." },
];

export const CORE_POLICY = Object.freeze({
  approvalRequiredFor: ["HIGH", "CRITICAL"] as Risk[],
  criticalRequiresTypedConfirmation: true,
  approvalTtlMinutes: 5,
  approvalsAreSingleUse: true,
  approvalsBoundToExactArguments: true,
  filesystemBoundary: "data/workspace (symlink-safe)",
  networkPolicy: "http(s) only, private/loopback/link-local addresses blocked",
  skillExecution: "isolated child process, Node permission model, stripped environment, timeouts, heap cap",
  untrustedContent: "wrapped as data, instruction-like lines removed, never triggers tools",
  mutableByAgentsOrEvolution: false,
});

export function capability(id: string): CapabilityDef {
  const c = CAPABILITIES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown capability: ${id}`);
  return c;
}

export async function getGrants(): Promise<Record<string, boolean>> {
  const rows = await db.select().from(permissionGrants);
  const map = new Map(rows.map((r) => [r.capability, r.granted]));
  const out: Record<string, boolean> = {};
  for (const c of CAPABILITIES) out[c.id] = map.get(c.id) ?? c.defaultGranted;
  return out;
}

export async function isGranted(cap: string): Promise<boolean> {
  const rows = await db.select().from(permissionGrants).where(eq(permissionGrants.capability, cap)).limit(1);
  return rows.length ? rows[0].granted : capability(cap).defaultGranted;
}

/** Only the human user (actor "user") can change grants - agents and the evolution engine cannot. */
export async function setGrant(cap: string, granted: boolean, actor: string) {
  if (actor !== "user") {
    await audit({ actor, action: "grant.change", tool: cap, risk: "CRITICAL", decision: "denied", details: { reason: "only the user can change permissions" } });
    throw new Error("permission grants can only be changed by the user");
  }
  capability(cap);
  await db
    .insert(permissionGrants)
    .values({ capability: cap, granted })
    .onConflictDoUpdate({ target: permissionGrants.capability, set: { granted, updatedAt: new Date() } });
  await audit({ actor, action: "grant.change", tool: cap, risk: capability(cap).risk, decision: granted ? "granted" : "revoked" });
}

export const argsHash = (tool: string, args: unknown) => sha256(`${tool}:${stableStringify(args)}`);

export async function createApproval(p: { tool: string; args: Record<string, unknown>; risk: Risk; summary: string }) {
  await expireApprovals();
  const expiresAt = new Date(Date.now() + CORE_POLICY.approvalTtlMinutes * 60_000);
  const [row] = await db
    .insert(approvals)
    .values({ tool: p.tool, args: p.args, argsHash: argsHash(p.tool, p.args), risk: p.risk, summary: p.summary, expiresAt })
    .returning();
  await audit({ actor: "system", action: "approval.requested", tool: p.tool, risk: p.risk, decision: "pending", details: { approvalId: row.id, summary: p.summary } });
  return row;
}

export async function expireApprovals() {
  await db
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, new Date())));
  await db
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.status, "approved"), lt(approvals.expiresAt, new Date())));
}

export async function decideApproval(id: string, decision: "approve" | "deny", confirm?: string) {
  await expireApprovals();
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
  if (!row) return { ok: false as const, error: "approval not found" };
  if (row.status !== "pending") return { ok: false as const, error: `approval is ${row.status}` };
  if (decision === "approve" && row.risk === "CRITICAL" && confirm !== "CONFIRM") {
    return { ok: false as const, error: 'CRITICAL operations require typing "CONFIRM"' };
  }
  const status = decision === "approve" ? "approved" : "denied";
  await db.update(approvals).set({ status, decidedAt: new Date() }).where(eq(approvals.id, id));
  await audit({ actor: "user", action: "approval.decided", tool: row.tool, risk: row.risk, decision: status, details: { approvalId: id } });
  return { ok: true as const, approval: { ...row, status } };
}

/** Atomically consume an approved approval. Succeeds once, only for the exact tool + args. */
export async function consumeApproval(id: string, tool: string, args: unknown): Promise<{ ok: boolean; error?: string }> {
  await expireApprovals();
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
  if (!row) return { ok: false, error: "approval not found" };
  if (row.tool !== tool || row.argsHash !== argsHash(tool, args)) return { ok: false, error: "approval does not match this operation" };
  const updated = await db
    .update(approvals)
    .set({ status: "consumed" })
    .where(and(eq(approvals.id, id), eq(approvals.status, "approved")))
    .returning({ id: approvals.id });
  if (updated.length === 0) return { ok: false, error: `approval is ${row.status}, not approved` };
  return { ok: true };
}

export async function listApprovals(limit = 30) {
  await expireApprovals();
  return db.select().from(approvals).orderBy(desc(approvals.createdAt)).limit(limit);
}
