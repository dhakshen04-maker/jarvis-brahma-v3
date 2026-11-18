/**
 * Evolution engine: measures real behaviour, detects repeated failures and capability gaps, and proposes
 * improvements. Suggestions are never self-applied: a human approves, and only allow-listed
 * low-authority actions can be applied. It has no code path that edits permissions, the core policy,
 * or the sandbox - those are frozen in code (see permissions.ts CORE_POLICY).
 */
import { db } from "@/db";
import { evolutionSuggestions, metrics, modelUsage, skillVersions, skills } from "@/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { avg, percentile, truncate } from "@/lib/util";
import { createDraftVersion, getSkillDetail, rollbackSkill, setSkillEnabled, testVersion } from "@/lib/skills/registry";
import { startAcquisition } from "@/lib/skills/acquisition";
import { isGranted } from "@/lib/permissions";
import { audit } from "@/lib/log";
import { tokenizeText } from "@/lib/memory/embedding";
import { recordExperience } from "@/lib/memory/store";

type J = Record<string, unknown>;
const DAYS = 7;
const since = () => new Date(Date.now() - DAYS * 86_400_000);

async function metricRows(name: string) {
  return db.select().from(metrics).where(and(eq(metrics.name, name), gte(metrics.ts, since()))).orderBy(desc(metrics.ts)).limit(2000);
}

export async function evolutionReport() {
  const [chat, tool, skillRuns, voiceLat, voiceConf, retr, miss, unhandled, agentRuns, cpu, ram] = await Promise.all(
    ["chat.turn", "tool.run", "skill.run", "voice.latency_ms", "voice.confidence", "memory.retrieval_score", "memory.retrieval_miss", "intent.unhandled", "agent.run", "system.cpu", "system.ram"].map(metricRows),
  );
  const rate = (rows: Array<{ value: number }>) => (rows.length ? Math.round((rows.filter((r) => r.value > 0).length / rows.length) * 1000) / 10 : null);
  const usage = await db.select({ status: modelUsage.status, ms: modelUsage.latencyMs }).from(modelUsage).where(gte(modelUsage.ts, since()));
  const skillRows = await db.select().from(skills);
  const reliability = skillRows.filter((s) => s.usageCount > 0).map((s) => ({ slug: s.slug, runs: s.usageCount, successRate: Math.round((s.successCount / s.usageCount) * 1000) / 10, status: s.status })).sort((a, b) => a.successRate - b.successRate);
  const versions = await db.select({ slug: skills.slug, version: skillVersions.version, status: skillVersions.status, origin: skillVersions.origin, changelog: skillVersions.changelog, createdAt: skillVersions.createdAt, active: sql<boolean>`${skills.activeVersionId} = ${skillVersions.id}` }).from(skillVersions).innerJoin(skills, eq(skills.id, skillVersions.skillId)).orderBy(desc(skillVersions.createdAt)).limit(25);
  const suggestions = await db.select().from(evolutionSuggestions).orderBy(desc(evolutionSuggestions.createdAt)).limit(40);
  const latencies = voiceLat.map((r) => r.value);
  return {
    windowDays: DAYS,
    indicators: {
      tasks: { total: chat.length, successRatePct: rate(chat) },
      tools: { total: tool.length, successRatePct: rate(tool) },
      skills: { runs: skillRuns.length, successRatePct: rate(skillRuns) },
      agents: { runs: agentRuns.length, verifiedRatePct: rate(agentRuns) },
      voice: { samples: latencies.length, avgLatencyMs: Math.round(avg(latencies)), p95LatencyMs: Math.round(percentile(latencies, 95)), recognitionSamples: voiceConf.length, avgConfidence: Math.round(avg(voiceConf.map((r) => r.value)) * 100) / 100 },
      memory: { retrievals: retr.length, avgTopScore: Math.round(avg(retr.map((r) => r.value)) * 1000) / 1000, misses: miss.length },
      model: { calls: usage.length, errorRatePct: usage.length ? Math.round((usage.filter((u) => u.status !== "ok").length / usage.length) * 1000) / 10 : null, avgLatencyMs: Math.round(avg(usage.filter((u) => u.status === "ok").map((u) => u.ms))) },
      resources: { cpuAvgPct: Math.round(avg(cpu.map((r) => r.value)) * 10) / 10, ramAvgPct: Math.round(avg(ram.map((r) => r.value)) * 10) / 10, samples: cpu.length },
      capabilityGaps: unhandled.length,
    },
    skillReliability: reliability,
    versionHistory: versions,
    suggestions,
  };
}

async function propose(type: string, key: string, title: string, rationale: string, evidence: J, payload: J) {
  const existing = await db.select({ id: evolutionSuggestions.id, status: evolutionSuggestions.status }).from(evolutionSuggestions).where(and(eq(evolutionSuggestions.type, type), eq(evolutionSuggestions.key, key))).limit(5);
  if (existing.some((e) => e.status === "proposed" || e.status === "approved")) return false;
  await db.insert(evolutionSuggestions).values({ type, key, title, rationale, evidence, payload });
  return true;
}

export async function analyze() {
  let created = 0;
  // 1. skills failing repeatedly
  const skillRows = await db.select().from(skills);
  for (const s of skillRows) {
    if (s.usageCount >= 3 && s.failureCount / s.usageCount > 0.3) {
      const rate = Math.round((s.failureCount / s.usageCount) * 100);
      if (await propose("retest_skill", s.slug, `Re-run validation for ${s.slug}`, `${rate}% of ${s.usageCount} runs failed. Re-validation shows whether the active version is still sound.`, { runs: s.usageCount, failures: s.failureCount }, { skillId: s.id })) created++;
      const detail = await getSkillDetail(s.id);
      const prev = detail?.versions.find((v) => v.id !== detail.activeVersionId && (v.status === "TESTED" || v.status === "VERIFIED"));
      if (prev && (await propose("rollback_skill", s.slug, `Roll back ${s.slug} to v${prev.version}`, `Active version fails ${rate}% of runs; v${prev.version} previously passed validation (${prev.status}).`, { to: prev.version }, { skillId: s.id, versionId: prev.id }))) created++;
    }
    if (s.status === "FAILED" && s.enabled && (await propose("disable_skill", s.slug, `Disable failed skill ${s.slug}`, "Its active version failed validation; it never runs automatically but still appears in the library.", {}, { skillId: s.id }))) created++;
  }
  // 2. repeated runtime errors -> regression tests
  const runs = await metricRows("skill.run");
  const failures = new Map<string, { n: number; error: string; input?: string; slug: string }>();
  for (const r of runs) {
    if (r.value > 0) continue;
    const l = r.labels as { slug?: string; error?: string; input?: string };
    if (!l.slug || !l.error || !l.input) continue;
    const k = `${l.slug}|${l.error}`;
    const e = failures.get(k) ?? { n: 0, error: l.error, input: l.input, slug: l.slug };
    e.n++;
    failures.set(k, e);
  }
  for (const [k, f] of failures) {
    if (f.n < 2 || /^invalid input/.test(f.error)) continue;
    const [skill] = await db.select().from(skills).where(eq(skills.slug, f.slug)).limit(1);
    if (!skill) continue;
    let input: unknown;
    try { input = JSON.parse(f.input!); } catch { continue; }
    if (await propose("add_regression_test", k, `Add regression test to ${f.slug}`, `The same runtime error occurred ${f.n} times: "${truncate(f.error, 80)}". A test pins this behaviour in a draft version for review.`, { occurrences: f.n }, { skillId: skill.id, test: { name: `regression: ${truncate(f.error, 50)}`, input, expectError: truncate(f.error, 60) } })) created++;
  }
  // 3. capability gaps: repeated unhandled requests
  const unhandled = await metricRows("intent.unhandled");
  const groups = new Map<string, { n: number; sample: string }>();
  for (const u of unhandled) {
    const text = String((u.labels as { text?: string }).text ?? "");
    const key = tokenizeText(text).slice(0, 4).sort().join(" ");
    if (!key) continue;
    const g = groups.get(key) ?? { n: 0, sample: text };
    g.n++;
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    if (g.n >= 2 && (await propose("build_skill", key, `Acquire a skill for: "${truncate(g.sample, 60)}"`, `This kind of request could not be handled ${g.n} times. Starting the acquisition protocol researches it, builds a sandboxed skill and validates it.`, { occurrences: g.n }, { request: `learn how to ${g.sample}` }))) created++;
  }
  // 4. advisories from voice/tool quality
  const rep = await evolutionReport();
  const v = rep.indicators.voice;
  if (v.samples >= 5 && v.p95LatencyMs > 4000 && (await propose("advisory", "voice-latency", "Voice latency is high", `p95 response latency is ${v.p95LatencyMs} ms over ${v.samples} turns. Consider a faster model for chat (Groq 8B / smaller Ollama model) or disabling sentence streaming delays.`, { p95: v.p95LatencyMs }, {}))) created++;
  if (v.recognitionSamples >= 5 && v.avgConfidence < 0.7 && (await propose("advisory", "recognition", "Speech recognition confidence is low", `Average confidence ${v.avgConfidence}. Check the microphone, reduce background noise, or pick the correct recognition language.`, { avg: v.avgConfidence }, {}))) created++;
  const tools = await metricRows("tool.run");
  const toolFails = new Map<string, number>();
  for (const t of tools) if (t.value === 0) toolFails.set(String((t.labels as { tool?: string }).tool), (toolFails.get(String((t.labels as { tool?: string }).tool)) ?? 0) + 1);
  for (const [t, n] of toolFails) if (n >= 3 && (await propose("advisory", `tool-${t}`, `Tool ${t} keeps failing`, `${n} failures in ${DAYS} days. Review its arguments, permissions or host environment.`, { failures: n }, {}))) created++;
  const retr = rep.indicators.memory;
  if (retr.misses >= 5 && retr.misses > retr.retrievals && (await propose("advisory", "memory-misses", "Memory retrieval often finds nothing", `${retr.misses} searches had no relevant result vs ${retr.retrievals} hits. Store more explicit facts with 'remember ...'.`, retr as unknown as J, {}))) created++;
  return { created, total: (await db.select({ n: sql<number>`count(*)::int` }).from(evolutionSuggestions).where(eq(evolutionSuggestions.status, "proposed")))[0].n };
}

export const APPLICABLE = ["retest_skill", "rollback_skill", "disable_skill", "build_skill", "add_regression_test", "advisory"] as const;

export async function decideSuggestion(id: string, decision: "approve" | "reject") {
  const [s] = await db.select().from(evolutionSuggestions).where(eq(evolutionSuggestions.id, id)).limit(1);
  if (!s) throw new Error("suggestion not found");
  if (s.status !== "proposed") throw new Error(`suggestion is ${s.status}`);
  await db.update(evolutionSuggestions).set({ status: decision === "approve" ? "approved" : "rejected", decidedAt: new Date() }).where(eq(evolutionSuggestions.id, id));
  await audit({ actor: "user", action: "evolution.decide", tool: s.type, risk: "HIGH", decision });
}

export async function applySuggestion(id: string) {
  if (!(await isGranted("evolution.apply"))) throw new Error("capability evolution.apply is not granted");
  const [s] = await db.select().from(evolutionSuggestions).where(eq(evolutionSuggestions.id, id)).limit(1);
  if (!s) throw new Error("suggestion not found");
  if (s.status !== "approved") throw new Error("only user-approved suggestions can be applied");
  if (!(APPLICABLE as readonly string[]).includes(s.type)) throw new Error(`suggestion type ${s.type} is not applicable (security policy and permissions can never be modified by evolution)`);
  const p = s.payload as { skillId?: string; versionId?: string; request?: string; test?: J };
  let result: J;
  try {
    switch (s.type) {
      case "retest_skill": {
        const d = await getSkillDetail(String(p.skillId));
        if (!d?.activeVersionId) throw new Error("skill has no active version");
        const rep = await testVersion(d.activeVersionId);
        result = { status: rep.status, tests: rep.summary };
        break;
      }
      case "rollback_skill": result = (await rollbackSkill(String(p.skillId), p.versionId, "evolution")) as unknown as J; break;
      case "disable_skill": await setSkillEnabled(String(p.skillId), false, "evolution"); result = { disabled: true }; break;
      case "build_skill": result = { acquisitionId: await startAcquisition(String(p.request)) }; break;
      case "add_regression_test": {
        const d = await getSkillDetail(String(p.skillId));
        const active = d?.versions.find((v) => v.id === d.activeVersionId);
        if (!d || !active) throw new Error("skill has no active version");
        const draft = await createDraftVersion(d.skill.id, { tests: [...(active.tests as never[]), p.test as never], changelog: "Regression test added by evolution (draft - promote to activate)" }, "evolution");
        result = { draftVersion: draft.version, status: draft.report.status, note: "draft created; promote it in the Skill Library to activate" };
        break;
      }
      default: result = { acknowledged: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.update(evolutionSuggestions).set({ status: "failed", result: { error: msg } }).where(eq(evolutionSuggestions.id, id));
    await recordExperience(`Evolution suggestion failed: ${s.type}`, msg, ["evolution"]);
    throw e;
  }
  await db.update(evolutionSuggestions).set({ status: "applied", result }).where(eq(evolutionSuggestions.id, id));
  await audit({ actor: "evolution", action: "evolution.apply", tool: s.type, risk: "HIGH", decision: "applied", details: { suggestion: s.title } });
  return result;
}
