/**
 * Multi-agent system. Ten agents communicate through structured messages persisted in agent_messages.
 * The ORCHESTRATOR plans a dependency graph from a template, schedules ready tasks in parallel,
 * tracks progress, retries transient failures, reassigns tasks whose agent cannot run (e.g. no model)
 * to a fallback agent (marking the result degraded), compares results through the CRITIC and only
 * reports "verified" when every required task succeeded without degradation and the critic approves.
 * Simple requests never reach this system - it is used for explicit delegation only.
 */
import { db } from "@/db";
import { agentMessages, agentRuns, agentTasks } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { complete, modelAvailable } from "@/lib/models/router";
import { researchTopic } from "@/lib/research";
import { addMemory, recordExperience, searchMemories } from "@/lib/memory/store";
import { createSkill, getSkillDetail, testVersion, USABLE, type SkillStatus } from "@/lib/skills/registry";
import { generateSkillSpec } from "@/lib/skills/acquisition";
import { decompose, engineerDiagnose, securityAudit } from "@/lib/engines";
import { scanCode, scanInjection } from "@/lib/security";
import { isGranted } from "@/lib/permissions";
import { errMsg, extractJson, slugify, truncate } from "@/lib/util";
import { audit, recordMetric } from "@/lib/log";

type J = Record<string, unknown>;
export type AgentId = "orchestrator" | "research" | "reasoning" | "engineering" | "security" | "testing" | "memory" | "critic" | "creator" | "strategy";

export interface AgentInfo {
  id: AgentId;
  name: string;
  role: string;
  needsModel: boolean;
  tools: string[];
}

export const AGENTS: AgentInfo[] = [
  { id: "orchestrator", name: "Orchestrator Agent", role: "Plans, assigns, tracks, reassigns and synthesises the verified result", needsModel: false, tools: ["task graph", "message bus"] },
  { id: "research", name: "Research Agent", role: "Researches unfamiliar topics across sources", needsModel: false, tools: ["web search", "page fetch", "source rating"] },
  { id: "reasoning", name: "Reasoning Agent", role: "Analyses complex problems, lists assumptions and uncertainty", needsModel: true, tools: ["reasoning model"] },
  { id: "engineering", name: "Engineering Agent", role: "Registers skills and runs system diagnostics", needsModel: false, tools: ["skill registry", "diagnostics"] },
  { id: "security", name: "Security Agent", role: "Reviews code, content and permissions for risk", needsModel: false, tools: ["static scan", "injection scan", "self-audit"] },
  { id: "testing", name: "Testing Agent", role: "Validates implementations in the sandbox", needsModel: false, tools: ["sandbox", "validator"] },
  { id: "memory", name: "Memory Agent", role: "Recalls and stores persistent knowledge and lessons", needsModel: false, tools: ["memory store"] },
  { id: "critic", name: "Critic Agent", role: "Challenges results, checks evidence and decides approve / reject", needsModel: false, tools: ["rule checks", "optional model critique"] },
  { id: "creator", name: "Creator Agent", role: "Develops new capability specifications", needsModel: true, tools: ["coding model"] },
  { id: "strategy", name: "Strategy Agent", role: "Decomposes goals and flags risks", needsModel: false, tools: ["decomposition", "optional model"] },
];

export interface AgentResult {
  ok: boolean;
  summary: string;
  data?: J;
  confidence?: number;
  issues?: string[];
  error?: string;
  degraded?: boolean;
}

interface PlanTask {
  key: string;
  agent: AgentId;
  title: string;
  objective: string;
  dependsOn: string[];
  optional?: boolean;
  tolerant?: boolean; // runs even if dependencies failed (critic, synthesis, memory)
  fallback?: AgentId;
  input?: J;
}

export function planFor(goal: string): { template: string; tasks: PlanTask[] } {
  const g = goal.trim();
  const audit_ = g.match(/audit\s+(?:the\s+)?skill\s+([\w.-]+)/i);
  if (audit_) {
    const slug = audit_[1];
    return { template: "audit_skill", tasks: [
      { key: "recall", agent: "memory", title: "Recall prior lessons about this skill", objective: slug, dependsOn: [], input: { mode: "recall", query: `skill ${slug}` } },
      { key: "scan", agent: "security", title: "Static security review", objective: slug, dependsOn: [], input: { skill: slug } },
      { key: "test", agent: "testing", title: "Re-validate in the sandbox", objective: slug, dependsOn: [], input: { skill: slug } },
      { key: "critique", agent: "critic", title: "Critique findings", objective: g, dependsOn: ["recall", "scan", "test"], tolerant: true },
      { key: "learn", agent: "memory", title: "Record the lesson", objective: g, dependsOn: ["critique"], tolerant: true, input: { mode: "store", kind: "experience" } },
      { key: "final", agent: "orchestrator", title: "Verified report", objective: g, dependsOn: ["critique", "learn"], tolerant: true },
    ] };
  }
  if (/\b(build|create|develop|acquire)\s+(?:a\s+|the\s+)?skill\b/i.test(g)) {
    const request = g.replace(/^(delegate:?\s*)?(build|create|develop|acquire)\s+(a\s+|the\s+)?skill\s*(to|that|for|:)?\s*/i, "") || g;
    return { template: "build_skill", tasks: [
      { key: "plan", agent: "strategy", title: "Decompose the capability", objective: request, dependsOn: [] },
      { key: "research", agent: "research", title: "Research references", objective: request, dependsOn: ["plan"], optional: true, input: { topic: request } },
      { key: "spec", agent: "creator", title: "Draft implementation + tests", objective: request, dependsOn: ["research"], input: { request } },
      { key: "review", agent: "security", title: "Review generated code", objective: request, dependsOn: ["spec"], input: { fromSpec: "spec" } },
      { key: "register", agent: "engineering", title: "Register skill in the library", objective: request, dependsOn: ["review"], input: { mode: "register", fromSpec: "spec" } },
      { key: "validate", agent: "testing", title: "Validate in the sandbox", objective: request, dependsOn: ["register"], input: { fromRegister: "register" } },
      { key: "critique", agent: "critic", title: "Critique outcome", objective: request, dependsOn: ["research", "review", "validate"], tolerant: true },
      { key: "learn", agent: "memory", title: "Record the lesson", objective: request, dependsOn: ["critique"], tolerant: true, input: { mode: "store", kind: "experience" } },
      { key: "final", agent: "orchestrator", title: "Verified report", objective: g, dependsOn: ["critique", "learn"], tolerant: true },
    ] };
  }
  if (/\b(diagnose|system health|why is .* slow)\b/i.test(g)) {
    return { template: "diagnose_system", tasks: [
      { key: "diag", agent: "engineering", title: "Measure live system state", objective: g, dependsOn: [], input: { mode: "diagnose" } },
      { key: "sec", agent: "security", title: "Security self-audit", objective: g, dependsOn: [], input: { mode: "audit" } },
      { key: "critique", agent: "critic", title: "Critique findings", objective: g, dependsOn: ["diag", "sec"], tolerant: true },
      { key: "final", agent: "orchestrator", title: "Verified report", objective: g, dependsOn: ["critique"], tolerant: true },
    ] };
  }
  if (/\b(research|investigate|learn about|study|look into)\b/i.test(g)) {
    const topic = g.replace(/^(delegate:?\s*)?(research|investigate|learn about|study|look into)\s+/i, "") || g;
    return { template: "research_topic", tasks: [
      { key: "plan", agent: "strategy", title: "Identify foundational concepts", objective: topic, dependsOn: [] },
      { key: "web", agent: "research", title: "Research and rate sources", objective: topic, dependsOn: ["plan"], input: { topic } },
      { key: "recall", agent: "memory", title: "Check existing knowledge", objective: topic, dependsOn: [], input: { mode: "recall", query: topic } },
      { key: "analyze", agent: "reasoning", title: "Analyse findings", objective: topic, dependsOn: ["web", "recall"], optional: true, fallback: "strategy" },
      { key: "critique", agent: "critic", title: "Challenge sources and claims", objective: topic, dependsOn: ["web", "recall", "analyze"], tolerant: true },
      { key: "store", agent: "memory", title: "Store verified knowledge", objective: topic, dependsOn: ["critique"], tolerant: true, input: { mode: "store", kind: "knowledge", from: "web" } },
      { key: "final", agent: "orchestrator", title: "Verified report", objective: g, dependsOn: ["critique", "store"], tolerant: true },
    ] };
  }
  return { template: "general", tasks: [
    { key: "plan", agent: "strategy", title: "Decompose the goal", objective: g, dependsOn: [] },
    { key: "recall", agent: "memory", title: "Recall relevant memory", objective: g, dependsOn: [], input: { mode: "recall", query: g } },
    { key: "analyze", agent: "reasoning", title: "Analyse and recommend", objective: g, dependsOn: ["plan", "recall"], fallback: "strategy" },
    { key: "critique", agent: "critic", title: "Challenge the analysis", objective: g, dependsOn: ["plan", "analyze"], tolerant: true },
    { key: "final", agent: "orchestrator", title: "Verified report", objective: g, dependsOn: ["critique"], tolerant: true },
  ] };
}

interface Ctx {
  runId: string;
  goal: string;
  task: PlanTask & { degraded?: boolean };
  results: Record<string, AgentResult>;
}

const needModel = async (task: "reasoning" | "coding") => {
  if (!(await modelAvailable(task))) throw new Error("no language model available for this agent");
};

type Impl = (c: Ctx) => Promise<AgentResult>;

const IMPL: Record<AgentId, Impl> = {
  async strategy(c) {
    const steps = decompose(c.task.objective);
    let note = "keyword decomposition only";
    let risks: unknown[] = [];
    if (await modelAvailable("reasoning")) {
      try {
        const r = await complete("agent", { json: true, temperature: 0.2, maxTokens: 600, messages: [{ role: "system", content: 'Reply JSON only: {"steps":string[],"risks":string[],"successCriteria":string[]}. Decompose the goal into reusable steps.' }, { role: "user", content: c.task.objective }] });
        const j = extractJson<{ steps?: string[]; risks?: string[] }>(r.text);
        if (j?.steps?.length) { return { ok: true, summary: `${j.steps.length} steps planned by ${r.provider}/${r.model}`, data: { steps: j.steps, risks: j.risks ?? [] }, confidence: 0.7, degraded: c.task.degraded }; }
      } catch (e) { note = `model unavailable (${errMsg(e)}); heuristic decomposition`; }
    }
    if (/(delete|migrate|replace|production|irreversible)/i.test(c.task.objective)) risks = ["potentially irreversible change"];
    return { ok: true, summary: `${steps.length} step(s) via ${note}`, data: { steps, risks }, confidence: 0.4, degraded: c.task.degraded };
  },
  async research(c) {
    if (!(await isGranted("research.web"))) return { ok: false, summary: "web research not permitted", error: "capability research.web is not granted" };
    const r = await researchTopic(String(c.task.input?.topic ?? c.task.objective), { store: false, maxPages: 3 });
    if (r.sources.length === 0) return { ok: false, summary: r.summary, error: r.warnings[0] ?? "no sources retrieved", data: { warnings: r.warnings } };
    const avg = r.sources.reduce((a, s) => a + s.score, 0) / r.sources.length / 100;
    return { ok: true, summary: `${r.sources.length} source(s), agreement ${r.comparison.agreement}`, confidence: Math.round(avg * 100) / 100, data: { summary: r.summary, sources: r.sources.map((s) => ({ title: s.title, url: s.url, reliability: s.reliability, score: s.score, injectionFlags: s.injectionFlags })), comparison: r.comparison, knowledgeMap: r.knowledgeMap, warnings: r.warnings, summaryMethod: r.summaryMethod } };
  },
  async memory(c) {
    const mode = c.task.input?.mode;
    if (mode === "recall") {
      const hits = await searchMemories({ query: String(c.task.input?.query ?? c.task.objective), limit: 5, touch: false });
      return { ok: true, summary: `${hits.length} relevant memories`, data: { memories: hits.map((m) => ({ id: m.id, layer: m.layer, title: m.title, score: m.score })) }, confidence: hits[0]?.score ?? 0 };
    }
    const verdict = (c.results.critique?.data?.verdict as string) ?? "reject";
    const kind = String(c.task.input?.kind ?? "experience");
    if (kind === "knowledge") {
      const web = c.results[String(c.task.input?.from ?? "web")];
      if (verdict !== "approve" || !web?.ok) return { ok: true, summary: "critic did not approve; nothing stored as verified knowledge", data: { stored: false } };
      const m = await addMemory({ layer: "knowledge", title: `Research: ${truncate(c.task.objective, 90)}`, content: `${String(web.data?.summary ?? "").slice(0, 6000)}\n\nSources:\n${((web.data?.sources as J[]) ?? []).map((s, i) => `[${i + 1}] ${s.title} - ${s.url} (${s.reliability})`).join("\n")}`, tags: ["research", "agent-verified"], source: "agents", force: true });
      return { ok: true, summary: m.ok ? "stored as knowledge memory (critic approved)" : `not stored: ${m.reason}`, data: { stored: m.ok } };
    }
    await recordExperience(`Agent run (${verdict}): ${truncate(c.task.objective, 80)}`, `Critic verdict ${verdict}. Issues: ${(c.results.critique?.issues ?? []).join("; ") || "none"}`, ["agents", verdict]);
    return { ok: true, summary: "lesson recorded in experience memory", data: { stored: true } };
  },
  async reasoning(c) {
    await needModel("reasoning");
    const context = Object.entries(c.results).map(([k, r]) => `${k}: ${truncate(r.summary, 300)}`).join("\n");
    const r = await complete("reasoning", { temperature: 0.3, maxTokens: 700, messages: [{ role: "system", content: "Analyse the goal using the prior agent findings. Give: key analysis, explicit assumptions, uncertainty, recommended next step. Be concise. Do not reveal hidden reasoning; give conclusions and evidence." }, { role: "user", content: `Goal: ${c.goal}\n\nFindings:\n${context}` }] });
    return { ok: true, summary: truncate(r.text.trim(), 600), data: { analysis: r.text.trim(), model: `${r.provider}/${r.model}` }, confidence: 0.65 };
  },
  async creator(c) {
    await needModel("coding");
    const request = String(c.task.input?.request ?? c.task.objective);
    const web = c.results.research;
    const ctx = web?.ok ? String(web.data?.summary ?? "").slice(0, 2500) : "";
    const spec = await generateSkillSpec(request, { name: truncate(request, 60), slug: `custom.${slugify(request).slice(0, 40) || "skill"}`, description: request, category: "General problem-solving", searchQuery: request, risks: [], feasible: true }, ctx);
    return { ok: true, summary: `drafted implementation with ${spec.tests.length} tests`, data: { spec: spec as unknown as J, name: truncate(request, 60), slug: `custom.${slugify(request).slice(0, 40) || "skill"}`, description: request }, confidence: 0.5 };
  },
  async security(c) {
    if (c.task.input?.mode === "audit") {
      const a = await securityAudit();
      const bad = a.checks.filter((x) => !x.passed);
      return { ok: bad.filter((x) => x.severity === "critical").length === 0, summary: `security score ${a.score}/100, ${a.passed}/${a.total} checks passed`, issues: bad.map((x) => `${x.name}: ${x.detail}`), data: { score: a.score, checks: a.checks as unknown as J[] }, confidence: a.score / 100 };
    }
    const issues: string[] = [];
    let code = "";
    if (c.task.input?.fromSpec) code = String((c.results[String(c.task.input.fromSpec)]?.data?.spec as J | undefined)?.code ?? "");
    else if (c.task.input?.skill) {
      const d = await getSkillDetail(String(c.task.input.skill));
      if (!d) return { ok: false, summary: "skill not found", error: `no skill ${c.task.input.skill}` };
      code = d.versions.find((v) => v.id === d.activeVersionId)?.code ?? "";
    }
    if (!code) return { ok: false, summary: "no code to review", error: "nothing to scan" };
    const scan = scanCode(code);
    for (const f of scan.findings) issues.push(`${f.severity}: ${f.message}`);
    const web = c.results.research ?? c.results.web;
    for (const s of ((web?.data?.sources as J[]) ?? [])) if ((s.injectionFlags as string[] | undefined)?.length) issues.push(`source ${s.url} contains instruction-like text`);
    const inj = scanInjection(code);
    if (inj.risky) issues.push(`code contains instruction-like strings (${inj.flags.join(", ")})`);
    return { ok: scan.ok, summary: scan.ok ? `static scan clean (${scan.findings.length} warnings)` : "static scan found forbidden constructs", issues, data: { findings: scan.findings as unknown as J[] }, confidence: scan.ok ? 0.8 : 0 };
  },
  async engineering(c) {
    if (c.task.input?.mode === "diagnose") {
      const d = await engineerDiagnose();
      const bad = d.findings.filter((f) => f.level !== "ok");
      return { ok: !d.findings.some((f) => f.level === "critical"), summary: d.findings.map((f) => f.message).join("; "), issues: bad.map((f) => f.message), data: { resources: d.resources as unknown as J, topProcesses: d.topProcesses as unknown as J[] }, confidence: 0.9 };
    }
    const spec = c.results[String(c.task.input?.fromSpec ?? "spec")]?.data as J | undefined;
    if (!spec) return { ok: false, summary: "no specification to register", error: "missing spec" };
    const s = spec.spec as J;
    let slug = String(spec.slug);
    const existing = await getSkillDetail(slug);
    if (existing) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const created = await createSkill({ slug, name: String(spec.name), description: String(spec.description), category: "General problem-solving", code: String(s.code), inputSchema: s.inputSchema as J, outputSchema: s.outputSchema as J, tests: s.tests as never, triggers: s.triggers as string[], limitations: String(s.limitations ?? "") }, "agents", "DEVELOPING");
    return { ok: true, summary: `registered ${slug}`, data: { skillId: created.skillId, versionId: created.versionId, slug, status: created.report.status }, confidence: 0.6 };
  },
  async testing(c) {
    let versionId: string | undefined;
    let slug = "";
    if (c.task.input?.fromRegister) {
      const reg = c.results[String(c.task.input.fromRegister)]?.data as J | undefined;
      versionId = reg?.versionId as string | undefined;
      slug = String(reg?.slug ?? "");
    } else if (c.task.input?.skill) {
      const d = await getSkillDetail(String(c.task.input.skill));
      if (!d) return { ok: false, summary: "skill not found", error: `no skill ${c.task.input.skill}` };
      versionId = d.activeVersionId ?? undefined;
      slug = d.skill.slug;
    }
    if (!versionId) return { ok: false, summary: "nothing to test", error: "no version" };
    const rep = await testVersion(versionId);
    const usable = USABLE.includes(rep.status as SkillStatus);
    return { ok: usable, summary: `${slug}: ${rep.status} - ${rep.summary.testsPassed}/${rep.summary.testsTotal} tests, ${rep.summary.checksPassed}/${rep.summary.checksTotal} checks`, issues: [...rep.checks.filter((x) => !x.passed).map((x) => `${x.name}: ${x.detail}`), ...rep.tests.filter((t) => !t.passed).map((t) => `test ${t.name}: ${t.detail}`)], data: { status: rep.status, resources: rep.resources as unknown as J }, confidence: usable ? (rep.status === "VERIFIED" ? 0.95 : 0.7) : 0.1 };
  },
  async critic(c) {
    const issues: string[] = [];
    const blockers: string[] = [];
    for (const [k, r] of Object.entries(c.results)) {
      if (k === c.task.key) continue;
      if (!r.ok) blockers.push(`${k}: ${r.error ?? r.summary}`);
      if (r.degraded) issues.push(`${k} ran in degraded mode (fallback agent) - lower confidence`);
      for (const i of r.issues ?? []) (/critical|forbidden|FAILED|failed/i.test(i) ? blockers : issues).push(`${k}: ${i}`);
    }
    const web = Object.values(c.results).find((r) => r.data?.sources);
    if (web) {
      const srcs = web.data!.sources as Array<{ reliability: string; injectionFlags?: string[] }>;
      if (srcs.every((s) => s.reliability === "low" || s.reliability === "unknown")) blockers.push("all sources are low reliability - claims are unverified");
      else if (srcs.length < 2) issues.push("only one source - cannot cross-check claims");
      const cmp = web.data!.comparison as { agreement: number } | undefined;
      if (cmp && srcs.length > 1 && cmp.agreement < 0.12) issues.push("sources diverge strongly - contradictions possible");
      if (srcs.some((s) => s.injectionFlags?.length)) issues.push("a source contained prompt-injection patterns (neutralised)");
    }
    let llm: string | undefined;
    if (await modelAvailable("reasoning")) {
      try {
        const r = await complete("agent", { temperature: 0.2, maxTokens: 300, messages: [{ role: "system", content: "You are a critical reviewer. In at most 4 bullet points, challenge assumptions and flag contradictions or unsupported claims in these agent results. If sound, say so." }, { role: "user", content: Object.entries(c.results).map(([k, r2]) => `${k} (${r2.ok ? "ok" : "failed"}): ${truncate(r2.summary, 300)}`).join("\n") }] });
        llm = r.text.trim();
      } catch { /* optional */ }
    }
    const verdict = blockers.length ? "reject" : "approve";
    return { ok: true, summary: `verdict: ${verdict}${blockers.length ? ` (${blockers.length} blocker${blockers.length > 1 ? "s" : ""})` : ""}${issues.length ? `, ${issues.length} caveat(s)` : ""}`, issues: [...blockers.map((b) => `BLOCKER ${b}`), ...issues], data: { verdict, blockers, caveats: issues, modelCritique: llm }, confidence: blockers.length ? 0.2 : Math.max(0.4, 0.9 - issues.length * 0.1) };
  },
  async orchestrator(c) {
    const rows = await db.select().from(agentTasks).where(eq(agentTasks.runId, c.runId));
    const required = rows.filter((t) => !t.optional && !t.input.tolerant && t.key !== "final");
    const allRequiredOk = required.every((t) => t.status === "done" && !(t.result as AgentResult | null)?.degraded);
    const verdict = (c.results.critique?.data?.verdict as string) ?? "approve";
    const verified = allRequiredOk && verdict === "approve";
    const lines = rows.filter((t) => t.key !== "final").map((t) => `${t.status === "done" ? "✔" : t.status === "skipped" ? "–" : "✘"} ${t.agent}: ${t.title}${t.status === "done" ? ` - ${(t.result as AgentResult | null)?.summary ?? ""}` : t.error ? ` - ${t.error}` : ""}`);
    return { ok: true, summary: `${verified ? "VERIFIED" : "NOT VERIFIED"}: ${lines.length} task(s)`, data: { verified, verdict, lines, issues: c.results.critique?.issues ?? [] }, confidence: verified ? 0.9 : 0.3 };
  },
};

const transient = (m: string) => /timed out|network|fetch failed|ECONN|rate limit/i.test(m);

export async function startRun(goal: string): Promise<string> {
  const plan = planFor(goal);
  const [run] = await db.insert(agentRuns).values({ goal: goal.slice(0, 500), template: plan.template }).returning({ id: agentRuns.id });
  for (const t of plan.tasks) {
    await db.insert(agentTasks).values({ runId: run.id, key: t.key, agent: t.agent, title: t.title, objective: t.objective.slice(0, 500), dependsOn: t.dependsOn, optional: !!t.optional, input: { ...(t.input ?? {}), tolerant: !!t.tolerant, fallback: t.fallback ?? null } });
  }
  await audit({ actor: "user", action: "agents.run", tool: plan.template, risk: "MEDIUM", decision: "allowed", details: { goal: truncate(goal, 100) } });
  void execute(run.id, goal).catch(async (e) => {
    await db.update(agentRuns).set({ status: "failed", error: errMsg(e), finishedAt: new Date() }).where(eq(agentRuns.id, run.id));
  });
  return run.id;
}

async function msg(runId: string, taskId: string | null, from: string, to: string, kind: string, payload: J) {
  await db.insert(agentMessages).values({ runId, taskId, fromAgent: from, toAgent: to, kind, payload });
}

async function execute(runId: string, goal: string) {
  const results: Record<string, AgentResult> = {};
  const settled = new Set<string>();
  await msg(runId, null, "orchestrator", "all", "run_started", { goal });
  for (let guard = 0; guard < 60; guard++) {
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.runId, runId));
    const pending = tasks.filter((t) => t.status === "pending");
    if (pending.length === 0) break;
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    const ready: typeof pending = [];
    for (const t of pending) {
      const deps = t.dependsOn.map((d) => byKey.get(d)!);
      if (deps.some((d) => d.status === "pending" || d.status === "running")) continue;
      const tolerant = !!t.input.tolerant;
      const failedDep = deps.find((d) => d.status === "failed" || d.status === "blocked") && !deps.every((d) => d.status === "done" || d.optional || d.status === "skipped");
      if (failedDep && !tolerant) {
        await db.update(agentTasks).set({ status: "blocked", error: "a required dependency failed", finishedAt: new Date() }).where(eq(agentTasks.id, t.id));
        await msg(runId, t.id, "orchestrator", t.agent, "task_blocked", { reason: "dependency failed" });
        continue;
      }
      ready.push(t);
    }
    if (ready.length === 0) continue;
    await Promise.all(ready.map(async (t) => {
      await db.update(agentTasks).set({ status: "running", startedAt: new Date(), attempts: t.attempts + 1 }).where(eq(agentTasks.id, t.id));
      await msg(runId, t.id, "orchestrator", t.agent, "task_assign", { objective: t.objective, dependsOn: t.dependsOn });
      const ctxResults: Record<string, AgentResult> = {};
      for (const d of t.dependsOn) if (results[d]) ctxResults[d] = results[d];
      const degraded = !!t.input.degraded;
      let res: AgentResult;
      try {
        res = await Promise.race([
          IMPL[t.agent as AgentId]({ runId, goal, task: { key: t.key, agent: t.agent as AgentId, title: t.title, objective: t.objective, dependsOn: t.dependsOn, input: t.input, degraded }, results: ctxResults }),
          new Promise<AgentResult>((_, rej) => setTimeout(() => rej(new Error("agent timed out after 120s")), 120_000)),
        ]);
        if (degraded) res.degraded = true;
      } catch (e) {
        res = { ok: false, summary: errMsg(e), error: errMsg(e) };
      }
      if (res.ok) {
        results[t.key] = res;
        settled.add(t.key);
        await db.update(agentTasks).set({ status: "done", result: res as unknown as J, finishedAt: new Date() }).where(eq(agentTasks.id, t.id));
        await msg(runId, t.id, t.agent, "orchestrator", "task_result", { summary: res.summary, confidence: res.confidence ?? null, issues: res.issues ?? [] });
        return;
      }
      await msg(runId, t.id, t.agent, "orchestrator", "task_failed", { error: res.error ?? res.summary, attempt: t.attempts + 1 });
      const fb = t.input.fallback as AgentId | null;
      if (transient(res.error ?? "") && t.attempts + 1 < 2) {
        await db.update(agentTasks).set({ status: "pending", error: res.error }).where(eq(agentTasks.id, t.id));
        await msg(runId, t.id, "orchestrator", t.agent, "task_retry", { reason: "transient failure" });
        return;
      }
      if (fb && fb !== t.agent && !degraded) {
        await db.update(agentTasks).set({ status: "pending", agent: fb, attempts: 0, error: null, input: { ...t.input, degraded: true } }).where(eq(agentTasks.id, t.id));
        await msg(runId, t.id, "orchestrator", fb, "task_reassigned", { from: t.agent, reason: res.error ?? res.summary });
        return;
      }
      results[t.key] = res;
      settled.add(t.key);
      await db.update(agentTasks).set({ status: "failed", error: res.error ?? res.summary, result: res as unknown as J, finishedAt: new Date() }).where(eq(agentTasks.id, t.id));
    }));
  }
  const rows = await db.select().from(agentTasks).where(eq(agentTasks.runId, runId));
  const final = rows.find((t) => t.key === "final");
  const finalRes = final?.result as AgentResult | null;
  const verified = !!finalRes?.data?.verified;
  const anyDone = rows.some((t) => t.status === "done");
  const status = verified ? "verified" : anyDone ? "completed_unverified" : "failed";
  await db.update(agentRuns).set({ status, finishedAt: new Date(), result: { verified, verdict: finalRes?.data?.verdict ?? null, lines: finalRes?.data?.lines ?? [], issues: finalRes?.data?.issues ?? [] } }).where(eq(agentRuns.id, runId));
  await msg(runId, null, "orchestrator", "all", "run_finished", { status });
  void recordMetric("agent.run", verified ? 1 : 0, { status });
}

export async function getRun(id: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  if (!run) return null;
  const [tasks, messages] = await Promise.all([
    db.select().from(agentTasks).where(eq(agentTasks.runId, id)).orderBy(agentTasks.createdAt),
    db.select().from(agentMessages).where(eq(agentMessages.runId, id)).orderBy(agentMessages.createdAt).limit(200),
  ]);
  return { run, tasks, messages };
}

export async function agentOverview() {
  const runs = await db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(15);
  const stats = await db
    .select({ agent: agentTasks.agent, status: agentTasks.status, n: sql<number>`count(*)::int` })
    .from(agentTasks)
    .groupBy(agentTasks.agent, agentTasks.status);
  const modelUp = await modelAvailable("reasoning");
  const agents = AGENTS.map((a) => {
    const s = stats.filter((x) => x.agent === a.id);
    const count = (st: string) => s.filter((x) => x.status === st).reduce((n, x) => n + x.n, 0);
    const running = count("running");
    return { ...a, running, done: count("done"), failed: count("failed") + count("blocked"), status: running > 0 ? "busy" : a.needsModel && !modelUp ? "degraded (needs model)" : "idle" };
  });
  return { agents, runs };
}

