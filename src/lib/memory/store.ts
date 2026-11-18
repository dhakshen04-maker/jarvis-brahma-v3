/**
 * Memory engine: six persistent layers, hybrid retrieval (hashed-vector cosine + keyword overlap +
 * importance + recency), duplicate detection, version history, user-controlled deletion, export.
 * Nothing is stored automatically except lessons in the experience layer (user-toggleable) - and
 * secrets/payment data are refused unless the user explicitly overrides.
 */
import { db } from "@/db";
import { memories, memoryVersions } from "@/db/schema";
import { and, desc, eq, inArray, isNull, lt, or, sql, gt } from "drizzle-orm";
import { cosine, embed, keywordOverlap, tokenizeText } from "@/lib/memory/embedding";
import { detectSecrets } from "@/lib/security";
import { sha256, truncate } from "@/lib/util";
import { getPrefs } from "@/lib/settings";
import { recordMetric } from "@/lib/log";

export type Layer = "short_term" | "long_term" | "project" | "skill" | "experience" | "knowledge";
export const LAYERS: Layer[] = ["short_term", "long_term", "project", "skill", "experience", "knowledge"];
export const LAYER_INFO: Record<Layer, string> = {
  short_term: "Temporary context (expires automatically)",
  long_term: "Persistent preferences and useful facts",
  project: "Project architecture, decisions and progress",
  skill: "Acquired skills, dependencies and validation results",
  experience: "Mistakes, successful solutions and lessons",
  knowledge: "Organised knowledge, documentation and references",
};

type Row = typeof memories.$inferSelect;
export type MemoryView = Omit<Row, "embedding" | "contentHash">;

function view(r: Row): MemoryView {
  const { embedding: _e, contentHash: _h, ...rest } = r;
  void _e;
  void _h;
  return rest;
}

export interface AddInput {
  layer: Layer;
  title?: string;
  content: string;
  tags?: string[];
  importance?: number;
  projectId?: string | null;
  source?: string;
  allowSensitive?: boolean;
  force?: boolean;
  ttlHours?: number;
  shared?: boolean;
}

export type AddResult =
  | { ok: true; memory: MemoryView; created: boolean; note?: string }
  | { ok: false; code: "sensitive" | "duplicate" | "invalid"; reason: string; existing?: MemoryView };

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export async function addMemory(p: AddInput): Promise<AddResult> {
  if (!LAYERS.includes(p.layer)) return { ok: false, code: "invalid", reason: `unknown memory layer: ${p.layer}` };
  const content = p.content?.trim() ?? "";
  if (content.length === 0 || content.length > 8000) return { ok: false, code: "invalid", reason: "content must be 1-8000 characters" };
  const secrets = detectSecrets(`${p.title ?? ""}\n${content}`);
  const sensitive = secrets.length > 0;
  if (sensitive && !p.allowSensitive) {
    return { ok: false, code: "sensitive", reason: `This looks like sensitive data (${secrets.join(", ")}). It was not stored. You can store it explicitly from the Memory dashboard.` };
  }
  const hash = sha256(`${p.layer}:${normalize(content)}`);
  const exact = await db.select().from(memories).where(and(eq(memories.layer, p.layer), eq(memories.contentHash, hash))).limit(1);
  if (exact.length) return { ok: true, created: false, memory: view(exact[0]), note: "an identical memory already exists" };

  const vec = embed(`${p.title ?? ""} ${content}`);
  if (!p.force) {
    const peers = await db.select().from(memories).where(eq(memories.layer, p.layer)).orderBy(desc(memories.updatedAt)).limit(600);
    for (const m of peers) {
      if (cosine(vec, m.embedding) >= 0.93) {
        return { ok: false, code: "duplicate", reason: "a near-duplicate memory already exists", existing: view(m) };
      }
    }
  }
  const title = (p.title?.trim() || truncate(content.replace(/\s+/g, " "), 70)).slice(0, 140);
  const expiresAt = p.layer === "short_term" ? new Date(Date.now() + (p.ttlHours ?? 24) * 3600_000) : null;
  const [row] = await db
    .insert(memories)
    .values({
      layer: p.layer, title, content, tags: (p.tags ?? []).slice(0, 12), importance: Math.min(5, Math.max(1, p.importance ?? 3)),
      sensitive, shared: p.shared ?? false, contentHash: hash, embedding: vec, projectId: p.projectId ?? null, source: p.source ?? "user", expiresAt,
    })
    .returning();
  await db.insert(memoryVersions).values({ memoryId: row.id, version: 1, title: row.title, content: row.content });
  return { ok: true, created: true, memory: view(row) };
}

export interface SearchOpts {
  query: string;
  layers?: Layer[];
  limit?: number;
  projectId?: string;
  includeSensitive?: boolean;
  sharedOnly?: boolean;
  touch?: boolean;
}
export type ScoredMemory = MemoryView & { score: number };

export async function searchMemories(o: SearchOpts): Promise<ScoredMemory[]> {
  await purgeExpired();
  const conds = [];
  if (o.layers?.length) conds.push(inArray(memories.layer, o.layers));
  if (o.projectId) conds.push(eq(memories.projectId, o.projectId));
  if (!o.includeSensitive) conds.push(eq(memories.sensitive, false));
  if (o.sharedOnly) conds.push(eq(memories.shared, true));
  const rows = await db.select().from(memories).where(conds.length ? and(...conds) : undefined).limit(3000);
  const qVec = embed(o.query);
  const qTokens = tokenizeText(o.query);
  const now = Date.now();
  const scored = rows
    .map((r) => {
      const docTokens = new Set(tokenizeText(`${r.title} ${r.content} ${r.tags.join(" ")}`));
      const cos = Math.max(0, cosine(qVec, r.embedding));
      const kw = keywordOverlap(qTokens, docTokens);
      const ageDays = (now - r.updatedAt.getTime()) / 86_400_000;
      const score = 0.5 * cos + 0.35 * kw + 0.1 * (r.importance / 5) + 0.05 * Math.exp(-ageDays / 90);
      return { r, score, relevant: cos >= 0.2 || kw > 0 };
    })
    .filter((x) => x.relevant && x.score >= 0.18)
    .sort((a, b) => b.score - a.score)
    .slice(0, o.limit ?? 8);
  if (o.touch !== false && scored.length) {
    await db.update(memories).set({ accessCount: sql`${memories.accessCount} + 1` }).where(inArray(memories.id, scored.map((s) => s.r.id)));
  }
  if (scored.length) void recordMetric("memory.retrieval_score", scored[0].score, { results: scored.length });
  else if (o.query.trim()) void recordMetric("memory.retrieval_miss", 1);
  return scored.map((s) => ({ ...view(s.r), score: Math.round(s.score * 1000) / 1000 }));
}

export async function listMemories(o: { layer?: Layer; limit?: number; includeSensitive?: boolean } = {}): Promise<MemoryView[]> {
  await purgeExpired();
  const conds = [];
  if (o.layer) conds.push(eq(memories.layer, o.layer));
  const rows = await db.select().from(memories).where(conds.length ? and(...conds) : undefined).orderBy(desc(memories.updatedAt)).limit(o.limit ?? 200);
  return rows.map(view);
}

export async function getMemory(id: string) {
  const [r] = await db.select().from(memories).where(eq(memories.id, id)).limit(1);
  return r ? view(r) : null;
}

export async function updateMemory(
  id: string,
  patch: { title?: string; content?: string; tags?: string[]; importance?: number; shared?: boolean; allowSensitive?: boolean },
): Promise<AddResult> {
  const [cur] = await db.select().from(memories).where(eq(memories.id, id)).limit(1);
  if (!cur) return { ok: false, code: "invalid", reason: "memory not found" };
  const content = patch.content !== undefined ? patch.content.trim() : cur.content;
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 140) : cur.title;
  if (!content || content.length > 8000) return { ok: false, code: "invalid", reason: "content must be 1-8000 characters" };
  const secrets = detectSecrets(`${title}\n${content}`);
  if (secrets.length && !patch.allowSensitive && !cur.sensitive) {
    return { ok: false, code: "sensitive", reason: `Sensitive data detected (${secrets.join(", ")}); not saved.` };
  }
  const changed = content !== cur.content || title !== cur.title;
  const version = changed ? cur.version + 1 : cur.version;
  const [row] = await db
    .update(memories)
    .set({
      title, content, version, updatedAt: new Date(),
      tags: patch.tags ?? cur.tags,
      importance: patch.importance !== undefined ? Math.min(5, Math.max(1, patch.importance)) : cur.importance,
      shared: patch.shared ?? cur.shared,
      sensitive: cur.sensitive || secrets.length > 0,
      contentHash: sha256(`${cur.layer}:${normalize(content)}`),
      embedding: embed(`${title} ${content}`),
    })
    .where(eq(memories.id, id))
    .returning();
  if (changed) await db.insert(memoryVersions).values({ memoryId: id, version, title, content });
  return { ok: true, created: false, memory: view(row) };
}

export async function deleteMemory(id: string): Promise<boolean> {
  const del = await db.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id });
  await db.delete(memoryVersions).where(eq(memoryVersions.memoryId, id));
  return del.length > 0;
}

export async function memoryHistory(id: string) {
  return db.select().from(memoryVersions).where(eq(memoryVersions.memoryId, id)).orderBy(desc(memoryVersions.version));
}

export async function purgeExpired() {
  await db.delete(memories).where(and(eq(memories.layer, "short_term"), lt(memories.expiresAt, new Date())));
}

export async function exportMemories(includeSensitive = false) {
  const rows = await db.select().from(memories).orderBy(memories.layer, desc(memories.updatedAt));
  const items = rows.filter((r) => includeSensitive || !r.sensitive).map(view);
  return { exportedAt: new Date().toISOString(), count: items.length, excludedSensitive: rows.length - items.length, memories: items };
}

export async function memoryStats() {
  await purgeExpired();
  const rows = await db
    .select({ layer: memories.layer, n: sql<number>`count(*)::int`, sensitive: sql<number>`count(*) filter (where ${memories.sensitive})::int` })
    .from(memories)
    .groupBy(memories.layer);
  const byLayer = Object.fromEntries(LAYERS.map((l) => [l, 0])) as Record<Layer, number>;
  let sensitive = 0;
  for (const r of rows) {
    byLayer[r.layer as Layer] = r.n;
    sensitive += r.sensitive;
  }
  return { byLayer, total: Object.values(byLayer).reduce((a, b) => a + b, 0), sensitive };
}

/** Lessons for the experience layer. Idempotent; honours the user's recordExperience preference. */
export async function recordExperience(title: string, content: string, tags: string[] = []) {
  try {
    if (!(await getPrefs()).recordExperience) return;
    await addMemory({ layer: "experience", title, content, tags, source: "system", importance: 3, force: true });
  } catch {
    /* never break the caller */
  }
}

export async function relevantContext(query: string, limit = 4) {
  const prefs = await getPrefs();
  if (!prefs.memoryInPrompts) return [];
  return searchMemories({ query, layers: ["long_term", "project", "knowledge", "experience", "short_term"], limit, touch: false });
}

export async function activeProjectMemories(projectId: string) {
  return db.select().from(memories).where(and(eq(memories.projectId, projectId), or(isNull(memories.expiresAt), gt(memories.expiresAt, new Date())))).orderBy(desc(memories.createdAt)).limit(100);
}
