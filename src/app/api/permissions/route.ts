import { db } from "@/db";
import { approvals, auditLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { body, json, route, str } from "@/lib/api";
import { CAPABILITIES, CORE_POLICY, decideApproval, getGrants, listApprovals, setGrant } from "@/lib/permissions";
import { invokeTool, listTools } from "@/lib/tools";
import { isUuid } from "@/lib/util";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const [grants, aps, audits] = await Promise.all([getGrants(), listApprovals(30), db.select().from(auditLog).orderBy(desc(auditLog.ts)).limit(60)]);
  return json({ capabilities: CAPABILITIES.map((c) => ({ ...c, granted: grants[c.id] })), policy: CORE_POLICY, tools: listTools(), approvals: aps, audit: audits });
});

export const POST = route(async (req: Request) => {
  const b = await body(req);
  const action = str(b.action);
  if (action === "grant") {
    await setGrant(str(b.capability), b.granted === true, "user");
    return json({ ok: true });
  }
  if (action === "decide") {
    const id = str(b.id);
    if (!isUuid(id)) return json({ error: "invalid id" }, 400);
    const r = await decideApproval(id, b.decision === "approve" ? "approve" : "deny", str(b.confirm));
    if (!r.ok) return json({ error: r.error }, 400);
    if (r.approval.status !== "approved") return json({ ok: true, status: "denied" });
    const outcome = await invokeTool(r.approval.tool, r.approval.args, { actor: "user", approvalId: id });
    await db.update(approvals).set({ result: { status: outcome.status, data: outcome.data ?? null, error: outcome.error ?? null } }).where(eq(approvals.id, id));
    return json({ ok: true, status: "approved", outcome });
  }
  return json({ error: "unknown action" }, 400);
});
