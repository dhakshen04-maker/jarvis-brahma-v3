/**
 * Authenticated device API (Bearer jb_...). Each endpoint also requires the matching per-device grant.
 *   GET  /api/device/poll     pending commands (marks them delivered)
 *   POST /api/device/result   { commandId, ok, result }
 *   POST /api/device/chat     { message, conversationId? } -> { text }
 *   GET  /api/device/skills   shared skill registry (read-only)
 *   GET  /api/device/memory?q memories the user explicitly marked shared
 */
import { body, json, route, str } from "@/lib/api";
import { authDevice, completeCommand, pollCommands } from "@/lib/devices";
import { handleMessage } from "@/lib/core/brahma";
import { listSkills } from "@/lib/skills/registry";
import { searchMemories } from "@/lib/memory/store";
import { isUuid } from "@/lib/util";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ action: string }> };

type Dev = NonNullable<Awaited<ReturnType<typeof authDevice>>>;

async function guard(req: Request, grant?: string): Promise<{ device: Dev } | { err: Response }> {
  const d = await authDevice(req);
  if (!d) return { err: json({ error: "invalid or missing device token" }, 401) };
  if (grant && !d.granted.includes(grant)) return { err: json({ error: `device has not been granted "${grant}"` }, 403) };
  return { device: d };
}

export const GET = route(async (req: Request, { params }: Ctx) => {
  const { action } = await params;
  if (action === "poll") {
    const g = await guard(req);
    if ("err" in g) return g.err;
    return json({ commands: await pollCommands(g.device.id) });
  }
  if (action === "skills") {
    const g = await guard(req, "skills.read");
    if ("err" in g) return g.err;
    const all = await listSkills();
    return json({ skills: all.filter((s) => s.enabled).map((s) => ({ slug: s.slug, name: s.name, description: s.description, category: s.category, status: s.status, version: s.version, inputSchema: s.inputSchema, outputSchema: s.outputSchema })) });
  }
  if (action === "memory") {
    const g = await guard(req, "memory.read");
    if ("err" in g) return g.err;
    const q = new URL(req.url).searchParams.get("q") ?? "";
    const items = q ? await searchMemories({ query: q, sharedOnly: true, limit: 10 }) : [];
    return json({ memories: items.map((m) => ({ id: m.id, layer: m.layer, title: m.title, content: m.content, score: m.score })) });
  }
  return json({ error: "unknown endpoint" }, 404);
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const { action } = await params;
  if (action === "result") {
    const g = await guard(req);
    if ("err" in g) return g.err;
    const b = await body<{ commandId?: string; ok?: boolean; result?: Record<string, unknown> }>(req);
    if (!isUuid(b.commandId)) return json({ error: "invalid commandId" }, 400);
    return json({ ok: await completeCommand(g.device.id, b.commandId, b.ok === true, b.result ?? {}) });
  }
  if (action === "chat") {
    const g = await guard(req, "chat");
    if ("err" in g) return g.err;
    const b = await body(req);
    const text = str(b.message).trim();
    if (!text) return json({ error: "message required" }, 400);
    let final = "";
    let conversationId: string | undefined;
    for await (const ev of handleMessage({ text, conversationId: str(b.conversationId) || undefined, voice: b.voice === true })) {
      if (ev.t === "done") {
        final = ev.text;
        conversationId = ev.meta.conversationId as string;
      }
    }
    return json({ text: final, conversationId });
  }
  return json({ error: "unknown endpoint" }, 404);
});
