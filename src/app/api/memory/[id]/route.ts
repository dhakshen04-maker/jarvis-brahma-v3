import { body, json, route, str } from "@/lib/api";
import { deleteMemory, getMemory, memoryHistory, updateMemory } from "@/lib/memory/store";
import { audit } from "@/lib/log";
import { isUuid } from "@/lib/util";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "invalid id" }, 400);
  const [memory, history] = await Promise.all([getMemory(id), memoryHistory(id)]);
  return memory ? json({ memory, history }) : json({ error: "not found" }, 404);
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "invalid id" }, 400);
  const b = await body(req);
  const r = await updateMemory(id, {
    title: typeof b.title === "string" ? b.title : undefined, content: typeof b.content === "string" ? b.content : undefined,
    tags: Array.isArray(b.tags) ? (b.tags as unknown[]).map(String) : undefined, importance: b.importance !== undefined ? Number(b.importance) : undefined,
    shared: typeof b.shared === "boolean" ? b.shared : undefined, allowSensitive: b.allowSensitive === true,
  });
  await audit({ actor: "user", action: "memory.edit", tool: str(id), risk: "MEDIUM", decision: r.ok ? "ok" : "refused" });
  return json(r, r.ok ? 200 : 400);
});

/** Explicit user deletion from the dashboard (chat-initiated deletion goes through the approval flow). */
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "invalid id" }, 400);
  const ok = await deleteMemory(id);
  await audit({ actor: "user", action: "memory.delete", tool: id, risk: "HIGH", decision: ok ? "ok" : "not_found" });
  return json({ ok });
});
