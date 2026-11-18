/**
 * Local, offline text embeddings using feature hashing of word uni/bi-grams and character trigrams.
 * This is a lexical-semantic vector (not a neural embedding): good for fuzzy matching, duplicate
 * detection and relevance ranking without any external service. Self-contained.
 */
export const EMBED_DIM = 256;

const STOP = new Set(
  "a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those i me my we our you your he she they them his her their do does did have has had not no so than too very can will just about into over under again".split(" "),
);

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenizeText(text: string): string[] {
  const raw = text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  return raw.filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

function fnv(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function embed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const add = (feature: string, weight: number) => {
    const h = fnv(feature);
    vec[h % EMBED_DIM] += (h & 0x10000 ? 1 : -1) * weight;
  };
  const toks = tokenizeText(text);
  toks.forEach((t, i) => {
    add("w:" + t, 1);
    if (i > 0) add("b:" + toks[i - 1] + "_" + t, 0.7);
    if (t.length > 3) for (let j = 0; j + 3 <= t.length; j++) add("c:" + t.slice(j, j + 3), 0.25);
  });
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => Math.round((v / norm) * 1e4) / 1e4);
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function keywordOverlap(queryTokens: string[], docTokens: Set<string>): number {
  if (queryTokens.length === 0) return 0;
  let hit = 0;
  for (const q of new Set(queryTokens)) if (docTokens.has(q)) hit++;
  return hit / new Set(queryTokens).size;
}
