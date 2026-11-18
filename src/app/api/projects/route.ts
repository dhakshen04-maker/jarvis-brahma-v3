import { db } from "@/db";
import { memories, projects } from "@/db/schema";
import { desc, sql } from "drizzle-orm";
import { body, json, route, str } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
  const counts = await db.select({ projectId: memories.projectId, n: sql<number>`count(*)::int` }).from(memories).groupBy(memories.projectId);
  return json({ projects: rows.map((p) => ({ ...p, notes: counts.find((c) => c.projectId === p.id)?.n ?? 0 })) });
});

export const POST = route(async (req: Request) => {
  const b = await body(req);
  const name = str(b.name).trim();
  if (!name) return json({ error: "name required" }, 400);
  const [p] = await db.insert(projects).values({ name: name.slice(0, 100), description: str(b.description).slice(0, 600) }).returning();
  return json({ project: p });
});
