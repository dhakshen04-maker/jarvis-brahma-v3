import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { body, json, route, str } from "@/lib/api";
import { activeProjectMemories, addMemory } from "@/lib/memory/store";
import { isUuid } from "@/lib/util";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "invalid id" }, 400);
  const [p] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!p) return json({ error: "not found" }, 404);
  const notes = await activeProjectMemories(id);
  return json({ project: p, notes: notes.map(({ embedding: _e, contentHash: _h, ...n }) => (void _e, void _h, n)) });
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "invalid id" }, 400);
  const b = await body(req);
  const [p] = await db.update(projects).set({ ...(b.status ? { status: str(b.status) } : {}), ...(typeof b.description === "string" ? { description: b.description.slice(0, 600) } : {}), updatedAt: new Date() }).where(eq(projects.id, id)).returning();
  return p ? json({ project: p }) : json({ error: "not found" }, 404);
});

/** Adds a project-memory note (architecture / decision / progress). */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "invalid id" }, 400);
  const b = await body(req);
  const kind = ["architecture", "decision", "progress", "note"].includes(str(b.kind)) ? str(b.kind) : "note";
  const r = await addMemory({ layer: "project", title: `${kind}: ${str(b.content).slice(0, 80)}`, content: str(b.content), tags: [kind], projectId: id, source: "user", importance: kind === "decision" || kind === "architecture" ? 4 : 3 });
  if (r.ok) await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
  return json(r, r.ok ? 200 : 400);
});
