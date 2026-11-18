/**
 * Permission-controlled tool registry. Every call goes through invokeTool():
 *   capability granted? -> HIGH/CRITICAL need a single-use approval bound to the exact arguments
 *   -> timeout-wrapped execution -> audit log + metrics + experience on failure.
 * Nothing can bypass this path: chat, agents and the UI all call invokeTool().
 */
import { capability, consumeApproval, createApproval, isGranted, type Risk } from "@/lib/permissions";
import { audit, recordMetric } from "@/lib/log";
import { errMsg } from "@/lib/util";
import { recordExperience, addMemory, deleteMemory, searchMemories, type Layer } from "@/lib/memory/store";
import { runSkill } from "@/lib/skills/registry";
import { researchTopic, searchWeb } from "@/lib/research";
import { queueCommand } from "@/lib/devices";
import {
  allowedApps, fsDelete, fsList, fsMkdir, fsRead, fsRestore, fsSearch, fsWrite, killProcess, listProcesses, openApp, runScript, systemInfo, systemResources,
} from "@/lib/tools/system";

type Args = Record<string, unknown>;
const str = (a: Args, k: string, d = "") => (typeof a[k] === "string" ? (a[k] as string) : d);

export interface ToolDef {
  name: string;
  description: string;
  capability: string;
  usage: string;
  summarize: (a: Args) => string;
  run: (a: Args) => Promise<unknown>;
}

const T = (t: ToolDef) => t;

export const TOOLS: ToolDef[] = [
  T({ name: "time.now", description: "Current date and time", capability: "chat.basic", usage: "time", summarize: () => "Read the clock", run: async () => ({ iso: new Date().toISOString(), local: new Date().toLocaleString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) }),
  T({ name: "system.info", description: "Operating system and hardware summary", capability: "system.read", usage: "system info", summarize: () => "Read system information", run: async () => systemInfo() }),
  T({ name: "system.resources", description: "Live CPU and memory usage", capability: "system.read", usage: "cpu usage", summarize: () => "Read CPU and memory usage", run: () => systemResources() }),
  T({ name: "process.list", description: "Top running processes", capability: "process.list", usage: "list processes", summarize: () => "List running processes", run: (a) => listProcesses(Number(a.limit) || 15) }),
  T({ name: "process.kill", description: "Terminate a process by PID", capability: "process.kill", usage: "kill process <pid>", summarize: (a) => `Terminate process ${a.pid}`, run: (a) => killProcess(Number(a.pid)) }),
  T({ name: "fs.list", description: "List a workspace directory", capability: "fs.read", usage: "list files [path]", summarize: (a) => `List ${str(a, "path", ".")}`, run: (a) => fsList(str(a, "path", ".")) }),
  T({ name: "fs.read", description: "Read a workspace text file", capability: "fs.read", usage: "read file <path>", summarize: (a) => `Read ${str(a, "path")}`, run: (a) => fsRead(str(a, "path")) }),
  T({ name: "fs.search", description: "Search workspace file names and contents", capability: "fs.read", usage: "search files <text>", summarize: (a) => `Search for "${str(a, "query")}"`, run: (a) => fsSearch(str(a, "query"), str(a, "path", ".")) }),
  T({ name: "fs.mkdir", description: "Create a workspace folder", capability: "fs.write", usage: "create folder <path>", summarize: (a) => `Create folder ${str(a, "path")}`, run: (a) => fsMkdir(str(a, "path")) }),
  T({ name: "fs.write", description: "Write a workspace file (old version backed up)", capability: "fs.write", usage: "create file <path>: <content>", summarize: (a) => `Write file ${str(a, "path")}`, run: (a) => fsWrite(str(a, "path"), str(a, "content"), a.overwrite === true) }),
  T({ name: "fs.delete", description: "Delete a workspace file (recoverable)", capability: "fs.delete", usage: "delete file <path>", summarize: (a) => `Delete file ${str(a, "path")} (moved to recoverable trash)`, run: (a) => fsDelete(str(a, "path")) }),
  T({ name: "fs.restore", description: "Restore a deleted file from trash", capability: "fs.write", usage: "restore file <trashId>", summarize: (a) => `Restore ${str(a, "trashId")}`, run: (a) => fsRestore(str(a, "trashId")) }),
  T({ name: "app.open", description: `Launch an allow-listed application (${allowedApps().join(", ") || "none on this OS"})`, capability: "app.open", usage: "open <app>", summarize: (a) => `Launch application "${str(a, "name")}"`, run: (a) => openApp(str(a, "name")) }),
  T({ name: "script.run", description: "Run a script from workspace/scripts with a 15 s timeout", capability: "script.run", usage: "run script <file>", summarize: (a) => `Execute script ${str(a, "file")}`, run: (a) => runScript(str(a, "file"), Array.isArray(a.args) ? (a.args as unknown[]).map(String) : []) }),
  T({
    name: "memory.add", description: "Store a memory", capability: "memory.write", usage: "remember <text>", summarize: (a) => `Store memory in ${str(a, "layer", "long_term")}`,
    run: async (a) => {
      const r = await addMemory({ layer: (str(a, "layer", "long_term") as Layer), title: str(a, "title") || undefined, content: str(a, "content"), tags: Array.isArray(a.tags) ? (a.tags as string[]) : [], allowSensitive: a.allowSensitive === true, source: str(a, "source", "chat") });
      if (!r.ok) throw new Error(r.reason);
      return r;
    },
  }),
  T({ name: "memory.search", description: "Search memory", capability: "memory.read", usage: "recall <query>", summarize: (a) => `Search memory for "${str(a, "query")}"`, run: (a) => searchMemories({ query: str(a, "query"), limit: Number(a.limit) || 6 }) }),
  T({ name: "memory.delete", description: "Delete a memory", capability: "memory.delete", usage: "forget <query>", summarize: (a) => `Delete memory "${str(a, "title", str(a, "id"))}"`, run: async (a) => ({ deleted: await deleteMemory(str(a, "id")) }) }),
  T({ name: "skill.run", description: "Run a skill in the sandbox", capability: "skill.execute", usage: "run skill <slug>", summarize: (a) => `Run skill ${str(a, "slug")}`, run: async (a) => runSkill(str(a, "slug"), a.input, { actor: "tool" }) }),
  T({ name: "research.search", description: "Web search", capability: "research.web", usage: "search the web for <q>", summarize: (a) => `Search the web: ${str(a, "query")}`, run: (a) => searchWeb(str(a, "query")) }),
  T({ name: "research.topic", description: "Research a topic across sources", capability: "research.web", usage: "research <topic>", summarize: (a) => `Research "${str(a, "topic")}"`, run: (a) => researchTopic(str(a, "topic"), { store: a.store === true }) }),
  T({ name: "android.launch_app", description: "Launch an app on a paired Android device", capability: "device.command", usage: "launch <app> on my phone", summarize: (a) => `Ask Android device to launch ${str(a, "app")}`, run: (a) => queueCommand("launch_app", { app: str(a, "app") }, str(a, "deviceId") || undefined) }),
  T({ name: "android.notify", description: "Show a notification on a paired Android device", capability: "device.command", usage: "notify my phone: <text>", summarize: (a) => `Send notification to Android device`, run: (a) => queueCommand("notify", { title: str(a, "title", "JARVIS"), message: str(a, "message") }, str(a, "deviceId") || undefined) }),
  T({ name: "android.device_info", description: "Request device info from a paired Android device", capability: "device.command", usage: "android device info", summarize: () => "Request Android device info", run: (a) => queueCommand("device_info", {}, str(a, "deviceId") || undefined) }),
];

export function listTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, usage: t.usage, capability: t.capability, risk: capability(t.capability).risk }));
}

export interface ToolOutcome {
  tool: string;
  risk: Risk;
  status: "ok" | "error" | "denied" | "approval_required";
  data?: unknown;
  error?: string;
  approval?: { id: string; summary: string; risk: Risk; expiresAt: string };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`tool timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export async function invokeTool(name: string, args: Args, ctx: { actor: string; approvalId?: string }): Promise<ToolOutcome> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { tool: name, risk: "LOW", status: "error", error: `unknown tool: ${name}` };
  const cap = capability(tool.capability);
  const risk = cap.risk;
  if (!(await isGranted(cap.id))) {
    await audit({ actor: ctx.actor, action: "tool.call", tool: name, risk, decision: "denied", details: { reason: "capability not granted" } });
    return { tool: name, risk, status: "denied", error: `Capability "${cap.label}" is not granted. Enable it in Settings > Permissions.` };
  }
  if (risk === "HIGH" || risk === "CRITICAL") {
    if (!ctx.approvalId) {
      const summary = tool.summarize(args);
      const ap = await createApproval({ tool: name, args, risk, summary });
      return { tool: name, risk, status: "approval_required", approval: { id: ap.id, summary, risk, expiresAt: ap.expiresAt.toISOString() } };
    }
    const c = await consumeApproval(ctx.approvalId, name, args);
    if (!c.ok) {
      await audit({ actor: ctx.actor, action: "tool.call", tool: name, risk, decision: "denied", details: { reason: c.error } });
      return { tool: name, risk, status: "denied", error: `Approval check failed: ${c.error}` };
    }
  }
  try {
    const data = await withTimeout(tool.run(args), 45_000);
    await audit({ actor: ctx.actor, action: "tool.call", tool: name, risk, decision: "ok", details: { summary: tool.summarize(args) } });
    void recordMetric("tool.run", 1, { tool: name, ok: true });
    return { tool: name, risk, status: "ok", data };
  } catch (e) {
    const msg = errMsg(e);
    await audit({ actor: ctx.actor, action: "tool.call", tool: name, risk, decision: "error", details: { error: msg } });
    void recordMetric("tool.run", 0, { tool: name, ok: false, error: msg.slice(0, 120) });
    await recordExperience(`Tool ${name} failed`, `Error: ${msg}. Check arguments and permissions before retrying.`, ["tool", name]);
    return { tool: name, risk, status: "error", error: msg };
  }
}
