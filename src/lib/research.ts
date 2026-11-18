/**
 * Research engine: real web search (SearXNG if configured, Wikipedia API, DuckDuckGo HTML), SSRF-safe
 * page retrieval, text extraction, source reliability rating, prompt-injection screening,
 * cross-source comparison, citations, knowledge maps and persistent reports.
 *
 * Reading about a topic is NOT an operational skill: reports are flagged operational=false until a
 * validated skill exists in the registry.
 */
import { db } from "@/db";
import { researchReports, researchSources } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { assertPublicUrl, scanInjection, wrapUntrusted, UNTRUSTED_NOTICE } from "@/lib/security";
import { tokenizeText } from "@/lib/memory/embedding";
import { complete, modelAvailable } from "@/lib/models/router";
import { addMemory } from "@/lib/memory/store";
import { recordMetric, logEvent } from "@/lib/log";
import { errMsg, truncate } from "@/lib/util";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

const UA = "JarvisBrahma/1.0 (research assistant; +local)";
// Tag matcher that respects quoted attribute values (Wikipedia embeds JSON containing ">" in attributes).
const TAG = /<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
const stripTags = (s: string) => s.replace(TAG, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

async function getJson(url: string, ms = 7000): Promise<unknown> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchSearx(q: string, n: number): Promise<SearchHit[]> {
  const base = process.env.SEARXNG_URL;
  if (!base) return [];
  const j = (await getJson(`${base.replace(/\/$/, "")}/search?q=${encodeURIComponent(q)}&format=json`)) as { results?: Array<{ title: string; url: string; content?: string }> };
  return (j.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "", engine: "searxng" }));
}

async function searchWikipedia(q: string, n: number): Promise<SearchHit[]> {
  const j = (await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=${n}`)) as {
    query?: { search?: Array<{ title: string; snippet: string }> };
  };
  return (j.query?.search ?? []).map((r) => ({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    snippet: stripTags(r.snippet),
    engine: "wikipedia",
  }));
}

async function searchDuckDuckGo(q: string, n: number): Promise<SearchHit[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { "user-agent": "Mozilla/5.0 (compatible; JarvisBrahma)" }, signal: AbortSignal.timeout(7000) });
  if (res.status !== 200) throw new Error(`DuckDuckGo returned ${res.status} (bot protection)`);
  const html = await res.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < n) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith("//")) url = "https:" + url;
    hits.push({ title: stripTags(m[2]), url, snippet: stripTags(m[3] ?? ""), engine: "duckduckgo" });
  }
  return hits;
}

export async function searchWeb(query: string, limit = 6): Promise<{ hits: SearchHit[]; errors: string[] }> {
  const errors: string[] = [];
  const results = await Promise.all(
    [["searxng", searchSearx], ["wikipedia", searchWikipedia], ["duckduckgo", searchDuckDuckGo]].map(async ([name, fn]) => {
      try {
        return await (fn as typeof searchWikipedia)(query, limit);
      } catch (e) {
        if (!(name === "searxng" && !process.env.SEARXNG_URL)) errors.push(`${name}: ${errMsg(e)}`);
        return [] as SearchHit[];
      }
    }),
  );
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const h of results.flat()) {
    const key = h.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(h);
  }
  return { hits: hits.slice(0, limit * 2), errors };
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  headings: string[];
  domain: string;
}

export function htmlToText(html: string): { title: string; text: string; headings: string[] } {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? "");
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => stripTags(m[1])).filter((h) => h.length > 2 && h.length < 120).slice(0, 40);
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = body
    .replace(TAG, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 25).join("\n");
  return { title, text, headings };
}

/** Wikipedia articles are fetched through the MediaWiki extracts API: clean plain text with section headings. */
async function fetchWikipedia(u: URL): Promise<FetchedPage | null> {
  const m = u.pathname.match(/^\/wiki\/(.+)$/);
  if (!m || !/(^|\.)wikipedia\.org$/.test(u.hostname)) return null;
  const title = decodeURIComponent(m[1]);
  const j = (await getJson(`https://${u.hostname}/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`, 9000)) as { query?: { pages?: Record<string, { title?: string; extract?: string }> } };
  const page = Object.values(j.query?.pages ?? {})[0];
  if (!page?.extract) return null;
  const headings = [...page.extract.matchAll(/^==+\s*(.+?)\s*==+$/gm)].map((x) => x[1]).filter((h) => !/^(references|external links|see also|notes|further reading|sources|bibliography)$/i.test(h));
  const text = page.extract.replace(/^==+\s*(.+?)\s*==+$/gm, "\n$1\n").split("\n").map((l) => l.trim()).filter((l) => l.length > 25).join("\n").slice(0, 40_000);
  return { url: u.toString(), title: `${page.title ?? title} - Wikipedia`, text, headings: headings.slice(0, 40), domain: u.hostname };
}

export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  let url = (await assertPublicUrl(rawUrl)).toString();
  try {
    const wiki = await fetchWikipedia(new URL(url));
    if (wiki) return wiki;
  } catch {
    /* fall back to HTML fetch */
  }
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,text/plain,application/json;q=0.8" }, redirect: "manual", signal: AbortSignal.timeout(9000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = (await assertPublicUrl(new URL(res.headers.get("location")!, url).toString())).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml/.test(type)) throw new Error(`unsupported content type: ${type || "unknown"}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > 1_500_000) {
        await reader.cancel();
        break;
      }
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed = /html/.test(type) ? htmlToText(raw) : { title: url, text: raw, headings: [] as string[] };
    return { url, title: parsed.title || url, text: parsed.text.slice(0, 40_000), headings: parsed.headings, domain: new URL(url).hostname };
  }
  throw new Error("too many redirects");
}

export interface Reliability {
  score: number;
  level: "high" | "medium" | "low" | "unknown";
  reasons: string[];
}

const HIGH = [/\.gov(\.|$)/, /\.edu(\.|$)/, /\.ac\.[a-z]{2}$/, /(^|\.)wikipedia\.org$/, /(^|\.)w3\.org$/, /(^|\.)ietf\.org$/, /(^|\.)rfc-editor\.org$/, /(^|\.)arxiv\.org$/, /(^|\.)nature\.com$/, /(^|\.)ieee\.org$/, /(^|\.)acm\.org$/, /(^|\.)developer\.mozilla\.org$/, /(^|\.)python\.org$/, /(^|\.)nodejs\.org$/, /(^|\.)kernel\.org$/, /(^|\.)who\.int$/, /(^|\.)nih\.gov$/, /(^|\.)nasa\.gov$/, /^docs\./, /^developer\./];
const MEDIUM = [/(^|\.)github\.com$/, /(^|\.)stackoverflow\.com$/, /(^|\.)microsoft\.com$/, /(^|\.)google\.com$/, /(^|\.)readthedocs\.io$/, /(^|\.)britannica\.com$/, /(^|\.)bbc\.(com|co\.uk)$/, /(^|\.)reuters\.com$/];
const LOW = [/(^|\.)medium\.com$/, /(^|\.)quora\.com$/, /(^|\.)reddit\.com$/, /blogspot\./, /(^|\.)wordpress\.com$/, /(^|\.)pinterest\./, /(^|\.)tiktok\.com$/];

export function rateSource(url: string, text: string): Reliability {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { score: 0, level: "unknown", reasons: ["invalid URL"] };
  }
  let score = 40;
  const reasons: string[] = [];
  if (HIGH.some((r) => r.test(host))) { score += 40; reasons.push("official / institutional / reference domain"); }
  else if (MEDIUM.some((r) => r.test(host))) { score += 20; reasons.push("reputable general source"); }
  else if (LOW.some((r) => r.test(host))) { score -= 15; reasons.push("user-generated content platform"); }
  else reasons.push("unknown publisher");
  if (url.startsWith("https://")) { score += 5; reasons.push("served over HTTPS"); } else { score -= 10; reasons.push("not HTTPS"); }
  if (text.length > 3000) { score += 5; reasons.push("substantial content"); } else if (text.length < 500) { score -= 10; reasons.push("very little content"); }
  if (/\b(20\d{2}|19\d{2})\b/.test(text.slice(0, 5000))) { score += 3; reasons.push("contains dates"); }
  if (/(buy now|limited offer|click here|miracle|guaranteed results|act now)/i.test(text)) { score -= 15; reasons.push("promotional language"); }
  const inj = scanInjection(text);
  if (inj.risky) { score -= 25; reasons.push(`prompt-injection patterns detected (${inj.flags.join(", ")})`); }
  score = Math.max(0, Math.min(100, score));
  return { score, level: score >= 70 ? "high" : score >= 50 ? "medium" : score >= 30 ? "low" : "unknown", reasons };
}

export function extractiveSummary(text: string, n = 4): string[] {
  const sentences = (text.match(/[^.!?\n]{30,300}[.!?]/g) ?? []).map((s) => s.trim());
  if (sentences.length <= n) return sentences;
  const freq = new Map<string, number>();
  for (const t of tokenizeText(text)) freq.set(t, (freq.get(t) ?? 0) + 1);
  const scored = sentences.map((s, i) => {
    const toks = tokenizeText(s);
    const sc = toks.reduce((a, t) => a + (freq.get(t) ?? 0), 0) / Math.sqrt(toks.length + 1) - i * 0.02;
    return { s, i, sc };
  });
  return scored.sort((a, b) => b.sc - a.sc).slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.s);
}

function topTerms(text: string, n = 20): string[] {
  const freq = new Map<string, number>();
  for (const t of tokenizeText(text)) if (t.length > 3) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
}

export interface ResearchSource {
  id?: string;
  n: number;
  url: string;
  title: string;
  domain: string;
  reliability: Reliability["level"];
  score: number;
  reasons: string[];
  excerpt: string;
  injectionFlags: string[];
}

export interface ResearchResult {
  topic: string;
  summary: string;
  summaryMethod: "llm" | "extractive" | "none";
  sources: ResearchSource[];
  knowledgeMap: { concepts: string[]; sections: string[]; tools: string[] };
  comparison: { agreement: number; note: string };
  warnings: string[];
  operational: false;
  operationalNote: string;
  reportId?: string;
  memoryId?: string;
}

export async function researchTopic(topic: string, opts: { store?: boolean; maxPages?: number } = {}): Promise<ResearchResult> {
  const warnings: string[] = [];
  const { hits, errors } = await searchWeb(topic, 6);
  warnings.push(...errors);
  if (hits.length === 0) {
    return { topic, summary: "No sources could be retrieved (search engines unreachable or no results).", summaryMethod: "none", sources: [], knowledgeMap: { concepts: [], sections: [], tools: [] }, comparison: { agreement: 0, note: "no sources" }, warnings, operational: false, operationalNote: "Nothing was learned.", };
  }
  const ranked = hits
    .filter((h) => !/disambiguation/i.test(h.url + h.title))
    .map((h) => ({ h, pre: rateSource(h.url, "x".repeat(3500)).score }))
    .sort((a, b) => b.pre - a.pre)
    .slice(0, Math.min(opts.maxPages ?? 3, 5));
  const fetched = await Promise.all(
    ranked.map(async ({ h }) => {
      try {
        return { h, page: await fetchPage(h.url) };
      } catch (e) {
        warnings.push(`could not fetch ${new URL(h.url).hostname}: ${errMsg(e)}`);
        return null;
      }
    }),
  );
  const sources: ResearchSource[] = [];
  const pages: FetchedPage[] = [];
  for (const f of fetched) {
    if (!f) continue;
    const rel = rateSource(f.page.url, f.page.text);
    const inj = scanInjection(f.page.text);
    const excerpt = extractiveSummary(f.page.text, 2).join(" ") || truncate(f.page.text, 300);
    const [row] = await db
      .insert(researchSources)
      .values({ url: f.page.url, title: f.page.title.slice(0, 200), domain: f.page.domain, reliability: rel.level, reliabilityScore: rel.score, reasons: rel.reasons, excerpt: excerpt.slice(0, 600), topic, injectionFlags: inj.flags })
      .onConflictDoUpdate({ target: researchSources.url, set: { reliability: rel.level, reliabilityScore: rel.score, reasons: rel.reasons, excerpt: excerpt.slice(0, 600), topic, injectionFlags: inj.flags, fetchedAt: new Date() } })
      .returning({ id: researchSources.id });
    sources.push({ id: row.id, n: sources.length + 1, url: f.page.url, title: f.page.title, domain: f.page.domain, reliability: rel.level, score: rel.score, reasons: rel.reasons, excerpt, injectionFlags: inj.flags });
    pages.push(f.page);
    if (inj.risky) warnings.push(`${f.page.domain}: contains instruction-like text (neutralised, never executed)`);
    if (rel.level === "low" || rel.level === "unknown") warnings.push(`${f.page.domain}: low reliability (${rel.reasons[0]})`);
  }
  if (sources.length === 0) {
    return { topic, summary: "Search results were found but none of the pages could be retrieved.", summaryMethod: "none", sources: [], knowledgeMap: { concepts: [], sections: [], tools: [] }, comparison: { agreement: 0, note: "no pages retrieved" }, warnings, operational: false, operationalNote: "Nothing was learned." };
  }

  // compare sources: overlap of dominant terms
  let agreement = 1;
  if (pages.length > 1) {
    const sets = pages.map((p) => new Set(topTerms(p.text)));
    let sum = 0, pairs = 0;
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
      const inter = [...sets[i]].filter((t) => sets[j].has(t)).length;
      sum += inter / new Set([...sets[i], ...sets[j]]).size;
      pairs++;
    }
    agreement = Math.round((sum / pairs) * 100) / 100;
  }
  const comparison = { agreement, note: pages.length < 2 ? "single source - cannot cross-check" : agreement > 0.25 ? "sources cover consistent core concepts" : "sources diverge; treat claims with caution" };

  const best = sources.reduce((a, b) => (b.score > a.score ? b : a));
  const bestPage = pages[sources.indexOf(best)];
  const allText = pages.map((p) => p.text).join("\n");
  const knowledgeMap = {
    concepts: topTerms(allText, 12),
    sections: [...new Set(bestPage.headings)].slice(0, 15),
    tools: [...new Set([...allText.matchAll(/(?:using|with|library|framework|tool|package|SDK|API)\s+([A-Z][\w.+-]{2,})/g)].map((m) => m[1]))].slice(0, 10),
  };

  let summary = "";
  let summaryMethod: ResearchResult["summaryMethod"] = "extractive";
  if (await modelAvailable("summarization")) {
    try {
      const block = pages.map((p, i) => `[${i + 1}] ${wrapUntrusted(p.text, p.domain, 3500)}`).join("\n\n");
      const r = await complete("summarization", {
        messages: [
          { role: "system", content: `You are a careful research summariser. Summarise findings about the topic in 5-8 sentences and cite sources as [1], [2]. Mention disagreements between sources and anything uncertain. ${UNTRUSTED_NOTICE}` },
          { role: "user", content: `Topic: ${topic}\n\n${block}` },
        ],
        temperature: 0.2,
        maxTokens: 700,
      });
      summary = r.text.trim();
      summaryMethod = "llm";
    } catch (e) {
      warnings.push(`model summary unavailable (${errMsg(e)}); used extractive summary`);
    }
  }
  if (!summary) summary = sources.map((s, i) => `${extractiveSummary(pages[i].text, 2).join(" ")} [${s.n}]`).join("\n\n");

  const [report] = await db
    .insert(researchReports)
    .values({ topic, summary, sourceIds: sources.map((s) => s.id!).filter(Boolean), knowledgeMap, operational: false })
    .returning({ id: researchReports.id });
  let memoryId: string | undefined;
  if (opts.store) {
    const m = await addMemory({
      layer: "knowledge", title: `Research: ${topic}`.slice(0, 120),
      content: `${summary}\n\nSources:\n${sources.map((s) => `[${s.n}] ${s.title} - ${s.url} (reliability: ${s.reliability})`).join("\n")}`.slice(0, 7900),
      tags: ["research", ...tokenizeText(topic).slice(0, 4)], source: "research", importance: 3, force: true,
    });
    if (m.ok) memoryId = m.memory.id;
  }
  void recordMetric("research.run", 1, { topic: truncate(topic, 60), sources: sources.length });
  void logEvent("info", "research", `researched "${truncate(topic, 60)}" (${sources.length} sources)`);
  return { topic, summary, summaryMethod, sources, knowledgeMap, comparison, warnings, operational: false, operationalNote: "This is knowledge about the topic, not an operational capability. A skill must be built and validated before JARVIS can perform it.", reportId: report.id, memoryId };
}

export async function listResearch() {
  const [sources, reports] = await Promise.all([
    db.select().from(researchSources).orderBy(desc(researchSources.fetchedAt)).limit(60),
    db.select().from(researchReports).orderBy(desc(researchReports.createdAt)).limit(30),
  ]);
  return { sources, reports };
}

export async function getSource(id: string) {
  const [s] = await db.select().from(researchSources).where(eq(researchSources.id, id)).limit(1);
  return s ?? null;
}
