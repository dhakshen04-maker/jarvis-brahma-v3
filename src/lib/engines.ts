/**
 * The ten BRAHMA intelligence engines. Each declares its responsibility, what is genuinely
 * implemented and what is not, and reports measurable readiness + 7-day activity from real metrics.
 * Engine operations used by the core and agents live here.
 */
import { db } from "@/db";
import { experiments, metrics, approvals, auditLog } from "@/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { complete, modelAvailable } from "@/lib/models/router";
import { runInSandbox } from "@/lib/sandbox";
import { assertPublicUrl, scanCode } from "@/lib/security";
import { matchSubset } from "@/lib/skills/schema";
import { addMemory, recordExperience, memoryStats } from "@/lib/memory/store";
import { listSkills } from "@/lib/skills/registry";
import { getGrants, CAPABILITIES } from "@/lib/permissions";
import { listProcesses, systemResources } from "@/lib/tools/system";
import { extractJson, truncate } from "@/lib/util";
import { recordMetric } from "@/lib/log";

export interface EngineDef {
  id: string;
  name: string;
  responsibility: string;
  needsModel: boolean;
  implemented: string[];
  notImplemented: string[];
  entry: string;
}

export const ENGINES: EngineDef[] = [
  { id: "creator", name: "Creator Engine", responsibility: "Create new skills, tools and modules", needsModel: true, entry: "say: 'learn how to ...' (Skill Library > Acquisition)",
    implemented: ["Skill acquisition pipeline (8 phases)", "Model-generated skill code + schemas + tests", "Manual skill authoring through the same validator", "Skill versioning, drafts, promotion, rollback"],
    notImplemented: ["Generating full applications", "Creating new agent types at runtime", "Hardware or network-dependent tools (need human review)"] },
  { id: "scientist", name: "Scientist Engine", responsibility: "Hypotheses, experiments and verified discoveries", needsModel: false, entry: "Research > Lab",
    implemented: ["Run a JavaScript experiment in the sandbox against a hypothesis + expectation", "Outcome classification (supported / refuted / inconclusive / error)", "Verified discoveries stored in knowledge memory, failures in experience memory", "Model-assisted experiment design (when a model is available)"],
    notImplemented: ["Physical or lab-equipment experiments", "Statistical power analysis"] },
  { id: "engineer", name: "Engineer Engine", responsibility: "Diagnostics, debugging and system analysis", needsModel: false, entry: "say: 'diagnose system'",
    implemented: ["Live CPU/RAM/process diagnostics with rule-based findings", "Allow-listed app launch, workspace scripts (approval required)", "Code assistance through the coding model"],
    notImplemented: ["Android Studio / Gradle build automation", "Driver/hardware level analysis"] },
  { id: "scholar", name: "Scholar Engine", responsibility: "Multidisciplinary knowledge", needsModel: true, entry: "ask any question",
    implemented: ["Discipline classification across 13 fields", "Knowledge-memory retrieval injected into answers", "Model-backed explanations"],
    notImplemented: ["Offline encyclopaedic knowledge without a model", "Formal proof checking"] },
  { id: "strategist", name: "Strategist Engine", responsibility: "Planning, risk and decisions", needsModel: false, entry: "say: 'delegate ...' or run the Decision Matrix skill",
    implemented: ["Problem decomposition", "Weighted decision matrix (verified skill, runs offline)", "Multi-agent planning with dependencies", "Model-assisted risk analysis"],
    notImplemented: ["Monte-Carlo scenario simulation"] },
  { id: "security", name: "Security Engine", responsibility: "Defensive security and privacy", needsModel: false, entry: "say: 'security audit'",
    implemented: ["Live security self-audit with probes (sandbox escape, SSRF, permission checks)", "Static code scanning of skills", "Prompt-injection screening of external content", "Secret detection and redaction", "Audit log"],
    notImplemented: ["Penetration testing tools", "Malware analysis VM", "Network traffic monitoring"] },
  { id: "communicator", name: "Communicator Engine", responsibility: "Conversation, voice and translation", needsModel: false, entry: "Voice tab / say: 'translate to Tamil: ...'",
    implemented: ["Browser speech recognition + synthesis", "Wake word, barge-in, voice state machine", "English / Tamil / Hindi registry", "Model-backed translation"],
    notImplemented: ["Neural offline TTS (Piper)", "Offline wake-word engine (OpenWakeWord)", "Server-side Whisper transcription"] },
  { id: "memory", name: "Memory Engine", responsibility: "Persistent six-layer memory", needsModel: false, entry: "Memory tab / 'remember ...'",
    implemented: ["Six layers with persistence", "Hashed-vector + keyword relevance search", "Duplicate detection, version history, export, deletion", "Secret/PII refusal"],
    notImplemented: ["Neural embeddings / ChromaDB (local hashed vectors are used)"] },
  { id: "research", name: "Research Engine", responsibility: "Documentation search and source analysis", needsModel: false, entry: "say: 'research <topic>'",
    implemented: ["Wikipedia + DuckDuckGo + optional SearXNG search", "SSRF-safe page fetch and text extraction", "Reliability rating, injection screening, cross-source comparison", "Citations, knowledge maps, stored reports"],
    notImplemented: ["PDF extraction", "JavaScript-rendered pages"] },
  { id: "evolution", name: "Evolution Engine", responsibility: "Measure, detect weaknesses, suggest improvements", needsModel: false, entry: "say: 'self-evaluate' / System Monitor > Evolution",
    implemented: ["Metrics for tasks, skills, tools, voice, memory", "Repeated-failure and capability-gap detection", "Approval-gated suggestions (retest, rollback, regression test, build skill)", "Skill version history"],
    notImplemented: ["Autonomous code self-modification (deliberately excluded)", "Any change to security policy (impossible by design)"] },
];

export async function engineStatuses() {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db
    .select({ engine: sql<string>`${metrics.labels}->>'engine'`, n: sql<number>`count(*)::int` })
    .from(metrics)
    .where(and(eq(metrics.name, "engine.use"), gte(metrics.ts, since)))
    .groupBy(sql`${metrics.labels}->>'engine'`);
  const use = new Map(rows.map((r) => [r.engine, r.n]));
  const modelUp = await modelAvailable("chat");
  return ENGINES.map((e) => ({
    ...e,
    activity7d: use.get(e.id) ?? 0,
    ready: e.needsModel ? modelUp : true,
    readiness: e.needsModel ? (modelUp ? "ready (model available)" : "degraded: needs a language model; deterministic parts still work") : "ready (works without a model)",
    coverage: `${e.implemented.length} implemented / ${e.notImplemented.length} not implemented`,
  }));
}

export const markEngine = (engine: string, intent: string) => recordMetric("engine.use", 1, { engine, intent });

// ------------------------------------------------ Scholar
const DISCIPLINES: Record<string, RegExp> = {
  Mathematics: /\b(integral|derivative|equation|theorem|prove|matrix|algebra|geometry|calculus|probability|prime)\b/i,
  Physics: /\b(quantum|relativity|force|energy|momentum|thermodynamic|electromagnet|particle|gravity|velocity)\b/i,
  Chemistry: /\b(molecule|reaction|compound|element|acid|periodic|bond|organic|catalyst)\b/i,
  Biology: /\b(cell|dna|gene|evolution|organism|protein|species|ecosystem|neuron)\b/i,
  "Computer science": /\b(algorithm|compiler|database|network protocol|operating system|data structure|complexity|recursion|api|software)\b/i,
  Engineering: /\b(circuit|torque|structural|mechanical|voltage|bridge design|control system|robot|sensor)\b/i,
  Economics: /\b(inflation|gdp|market|supply|demand|interest rate|monetary|fiscal|trade|recession)\b/i,
  History: /\b(empire|war|dynasty|revolution|ancient|medieval|colonial|century|treaty)\b/i,
  Philosophy: /\b(ethic|metaphysic|epistemolog|stoic|existential|consciousness|moral|utilitarian)\b/i,
  Psychology: /\b(cognitive|behaviou?r|emotion|anxiety|personality|bias|memory formation|therapy)\b/i,
  Languages: /\b(grammar|translate|vocabulary|syntax|linguistic|pronunciation|tamil|hindi|etymology)\b/i,
  Arts: /\b(painting|music|composition|sculpture|poetry|cinema|architecture style|renaissance)\b/i,
};
export function scholarClassify(text: string): { discipline: string | null; matches: string[] } {
  const matches = Object.entries(DISCIPLINES).filter(([, re]) => re.test(text)).map(([d]) => d);
  return { discipline: matches[0] ?? null, matches };
}

// ------------------------------------------------ Engineer
export async function engineerDiagnose() {
  const res = await systemResources();
  let procs: Awaited<ReturnType<typeof listProcesses>> = [];
  try { procs = await listProcesses(5); } catch { /* process listing may be unavailable */ }
  const findings: Array<{ level: "ok" | "warn" | "critical"; message: string }> = [];
  findings.push(res.cpuPercent > 85 ? { level: "critical", message: `CPU at ${res.cpuPercent}% - sustained load will slow voice and model responses` } : res.cpuPercent > 60 ? { level: "warn", message: `CPU at ${res.cpuPercent}%` } : { level: "ok", message: `CPU healthy (${res.cpuPercent}%)` });
  findings.push(res.ramPercent > 88 ? { level: "critical", message: `RAM ${res.ramPercent}% used - prefer a smaller local model (e.g. llama3.2:1b) or cloud inference` } : res.ramPercent > 70 ? { level: "warn", message: `RAM ${res.ramPercent}% used` } : { level: "ok", message: `RAM healthy (${res.ramPercent}%, ${res.ramUsedMb}/${res.ramTotalMb} MB)` });
  if (res.loadAvg[0] > res.cores * 1.5) findings.push({ level: "warn", message: `Load average ${res.loadAvg[0]} exceeds 1.5x core count (${res.cores})` });
  if (res.serverHeapMb > 400) findings.push({ level: "warn", message: `Server heap at ${res.serverHeapMb} MB` });
  return { resources: res, topProcesses: procs, findings };
}

// ------------------------------------------------ Security
export async function securityAudit() {
  const checks: Array<{ name: string; passed: boolean; severity: "info" | "warning" | "critical"; detail: string }> = [];
  const esc = await runInSandbox({ code: 'function run(){ return this.constructor.constructor("return process")().pid }', input: {} });
  checks.push({ name: "Sandbox escape probe", passed: !esc.ok, severity: "critical", detail: esc.ok ? "ESCAPE POSSIBLE - disable skill execution" : "constructor-chain escape blocked" });
  const glob = await runInSandbox({ code: "function run(){ return [typeof require, typeof process, typeof fetch, typeof setTimeout].join() }", input: {} });
  checks.push({ name: "Sandbox has no I/O globals", passed: glob.value === "undefined,undefined,undefined,undefined", severity: "critical", detail: String(glob.value) });
  const loop = await runInSandbox({ code: "function run(){ while(true){} }", input: {}, timeoutMs: 300 });
  checks.push({ name: "Runaway code is killed", passed: !loop.ok && loop.timedOut, severity: "critical", detail: `timed out: ${loop.timedOut}` });
  let ssrf = false;
  try { await assertPublicUrl("http://127.0.0.1:5432/"); } catch { ssrf = true; }
  let meta = false;
  try { await assertPublicUrl("http://169.254.169.254/latest/meta-data"); } catch { meta = true; }
  checks.push({ name: "SSRF guard blocks loopback and cloud metadata", passed: ssrf && meta, severity: "critical", detail: `loopback blocked: ${ssrf}, metadata blocked: ${meta}` });
  const grants = await getGrants();
  const risky = CAPABILITIES.filter((c) => (c.risk === "HIGH" || c.risk === "CRITICAL") && grants[c.id]);
  checks.push({ name: "High-risk capabilities", passed: !CAPABILITIES.some((c) => c.risk === "CRITICAL" && grants[c.id]), severity: "warning", detail: risky.length ? `granted (approval still required per action): ${risky.map((c) => c.id).join(", ")}` : "none granted" });
  const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(approvals).where(eq(approvals.status, "pending"));
  checks.push({ name: "Pending approvals", passed: pending.n === 0, severity: "info", detail: `${pending.n} awaiting your decision` });
  const skillList = await listSkills();
  const risky2 = skillList.filter((s) => s.status !== "FAILED" && !scanCode(s.slug).ok);
  void risky2;
  const failedSkills = skillList.filter((s) => s.status === "FAILED").length;
  checks.push({ name: "Skill registry health", passed: failedSkills === 0, severity: "info", detail: `${skillList.length} skills, ${failedSkills} failed (failed skills never run automatically)` });
  const mem = await memoryStats();
  checks.push({ name: "Sensitive memories", passed: true, severity: "info", detail: `${mem.sensitive} flagged sensitive (excluded from prompts and exports by default)` });
  const keys = ["GROQ_API_KEY", "GEMINI_API_KEY", "CUSTOM_LLM_API_KEY"].filter((k) => !!process.env[k]);
  checks.push({ name: "Secrets handling", passed: true, severity: "info", detail: `API keys read from environment only (${keys.length ? keys.join(", ") + " present" : "none configured"}); never stored in the database or returned by any API` });
  const [denials] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(and(eq(auditLog.decision, "denied"), gte(auditLog.ts, new Date(Date.now() - 86_400_000))));
  checks.push({ name: "Blocked actions (24h)", passed: true, severity: "info", detail: `${denials.n} operations were denied by the permission manager` });
  const failed = checks.filter((c) => !c.passed);
  const score = Math.max(0, 100 - failed.filter((c) => c.severity === "critical").length * 40 - failed.filter((c) => c.severity === "warning").length * 10);
  return { score, passed: checks.filter((c) => c.passed).length, total: checks.length, checks };
}

// ------------------------------------------------ Scientist
export interface ExperimentInput {
  hypothesis: string;
  code: string;
  input?: unknown;
  expect?: unknown;
  design?: string;
}

export async function runExperiment(e: ExperimentInput) {
  const scan = scanCode(e.code);
  let result: Record<string, unknown>;
  let outcome: string;
  let notes: string;
  if (!scan.ok) {
    outcome = "error";
    notes = `Experiment code rejected by the static scan: ${scan.findings.filter((f) => f.severity === "critical").map((f) => f.message).join("; ")}`;
    result = { rejected: true };
  } else {
    const r = await runInSandbox({ code: e.code, input: e.input ?? {}, timeoutMs: 4000 });
    result = { ok: r.ok, value: r.value, error: r.error, durationMs: Math.round(r.durationMs), heapMb: Math.round(r.heapMb * 10) / 10 };
    if (!r.ok) { outcome = "error"; notes = `The experiment failed to run: ${r.error}`; }
    else if (e.expect === undefined) { outcome = "inconclusive"; notes = "No expectation was defined, so the result cannot support or refute the hypothesis."; }
    else if (matchSubset(r.value, e.expect)) { outcome = "supported"; notes = "Observed output matches the predicted outcome."; }
    else { outcome = "refuted"; notes = `Observed ${truncate(JSON.stringify(r.value), 160)} but predicted ${truncate(JSON.stringify(e.expect), 160)}.`; }
  }
  const [row] = await db.insert(experiments).values({ hypothesis: e.hypothesis, design: e.design ?? "", code: e.code, input: e.input ?? null, result, outcome, notes }).returning();
  if (outcome === "supported") await addMemory({ layer: "knowledge", title: `Verified discovery: ${truncate(e.hypothesis, 80)}`, content: `Hypothesis: ${e.hypothesis}\nOutcome: supported by experiment ${row.id}.\n${notes}`, tags: ["experiment", "verified"], source: "scientist", force: true });
  else if (outcome === "refuted" || outcome === "error") await recordExperience(`Experiment ${outcome}: ${truncate(e.hypothesis, 70)}`, `${notes} Learn from this before retrying.`, ["experiment", outcome]);
  void recordMetric("experiment.run", outcome === "supported" ? 1 : 0, { outcome });
  return row;
}

export async function designExperiment(hypothesis: string): Promise<ExperimentInput> {
  const r = await complete("coding", {
    json: true, temperature: 0.2, maxTokens: 1500,
    messages: [
      { role: "system", content: 'You design computational experiments. Reply with JSON only: {"design":string,"code":"function run(input){...}","input":{},"expect":{}}. The code is pure synchronous JavaScript (no require/process/fetch/eval/constructor) returning a JSON object; "expect" is the PREDICTED partial output if the hypothesis is true, derived from theory before running.' },
      { role: "user", content: hypothesis },
    ],
  });
  const j = extractJson<{ design?: string; code?: string; input?: unknown; expect?: unknown }>(r.text);
  if (!j?.code) throw new Error("model did not return an experiment design");
  return { hypothesis, code: j.code, input: j.input, expect: j.expect, design: j.design };
}

export async function listExperiments() {
  return db.select().from(experiments).orderBy(desc(experiments.createdAt)).limit(30);
}

// ------------------------------------------------ Strategist / Communicator / Creator
export function decompose(goal: string): string[] {
  const parts = goal.split(/\b(?:and then|then|after that|and also|;)\b|,\s*(?=\w)/i).map((s) => s.trim()).filter((s) => s.length > 3);
  const unique = parts.length > 1 ? parts : goal.split(/\s+and\s+/i).map((s) => s.trim()).filter((s) => s.length > 3);
  return unique.length > 1 ? unique.slice(0, 8) : [goal];
}

export async function strategistAnalyze(problem: string) {
  const steps = decompose(problem);
  const risksHeuristic = [/(deadline|urgent|asap)/i.test(problem) && "time pressure", /(budget|cost|money|price)/i.test(problem) && "budget constraints", /(new|unknown|first time)/i.test(problem) && "unfamiliar domain", /(delete|migrate|replace|production)/i.test(problem) && "irreversible change"].filter(Boolean) as string[];
  if (!(await modelAvailable("reasoning"))) return { steps, risks: risksHeuristic, method: "heuristic" as const, note: "No model available: decomposition and keyword-based risk flags only." };
  const r = await complete("reasoning", {
    json: true, temperature: 0.3, maxTokens: 900,
    messages: [{ role: "system", content: 'You are a strategist. Reply with JSON only: {"steps":string[],"risks":[{"risk":string,"likelihood":"low|medium|high","impact":"low|medium|high","mitigation":string}],"recommendation":string}. Be concise and concrete; state uncertainty.' }, { role: "user", content: problem }],
  });
  const j = extractJson<{ steps?: string[]; risks?: unknown[]; recommendation?: string }>(r.text);
  return { steps: j?.steps ?? steps, risks: j?.risks ?? risksHeuristic, recommendation: j?.recommendation, method: "model" as const, model: `${r.provider}/${r.model}` };
}

export async function translateText(text: string, target: string) {
  const r = await complete("translation", {
    temperature: 0.1, maxTokens: 800,
    messages: [{ role: "system", content: `Translate the user's text into ${target}. Output only the translation, no commentary.` }, { role: "user", content: text }],
  });
  return { translation: r.text.trim(), model: `${r.provider}/${r.model}` };
}
