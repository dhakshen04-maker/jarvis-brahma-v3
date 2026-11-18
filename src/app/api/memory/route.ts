import { body, json, route, str } from "@/lib/api";
import { addMemory, exportMemories, LAYERS, LAYER_INFO, listMemories, memoryStats, searchMemories, type Layer } from "@/lib/memory/store";
import { isGranted } from "@/lib/permissions";
import { audit } from "@/lib/log";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const u = new URL(req.url).searchParams;
  if (u.get("export") === "1") {
    const data = await exportMemories(u.get("sensitive") === "1");
    return new Response(JSON.stringify(data, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="brahma-memory-${new Date().toISOString().slice(0, 10)}.json"` } });
  }
  const layer = u.get("layer") as Layer | null;
  const q = u.get("q")?.trim();
  const stats = await memoryStats();
  const items = q
    ? await searchMemories({ query: q, layers: layer && LAYERS.includes(layer) ? [layer] : undefined, limit: 40, includeSensitive: true })
    : await listMemories({ layer: layer && LAYERS.includes(layer) ? layer : undefined, limit: 200 });
  return json({ stats, items, layers: LAYERS.map((l) => ({ id: l, description: LAYER_INFO[l] })) });
});

export const POST = route(async (req: Request) => {
  if (!(await isGranted("memory.write"))) return json({ error: "memory.write is not granted" }, 403);
  const b = await body(req);
  const r = await addMemory({
    layer: str(b.layer, "long_term") as Layer, title: str(b.title) || undefined, content: str(b.content),
    tags: Array.isArray(b.tags) ? (b.tags as unknown[]).map(String) : [], importance: Number(b.importance) || 3,
    projectId: str(b.projectId) || null, allowSensitive: b.allowSensitive === true, force: b.force === true, shared: b.shared === true, source: "user",
  });
  await audit({ actor: "user", action: "memory.add", tool: "memory", risk: "MEDIUM", decision: r.ok ? "ok" : "refused", details: { layer: str(b.layer), reason: r.ok ? undefined : r.reason } });
  return json(r, r.ok ? 200 : r.code === "invalid" ? 400 : 409);
});
