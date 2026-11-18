/**
 * SKILL ACQUISITION PROTOCOL
 *   IDENTIFY -> RESEARCH -> DECOMPOSE -> DEVELOP -> SANDBOX -> VALIDATE -> REGISTER -> IMPROVE
 *
 * Honest limits:
 *  - DEVELOP needs a language model (Groq / Gemini / Ollama / OpenAI-compatible). Without one the
 *    pipeline stops with status "blocked" and the user may submit a manual implementation, which then
 *    goes through exactly the same sandbox + validation + registration steps.
 *  - Skills are pure, synchronous JavaScript executed in the sandbox. Requests that need host/network
 *    access are not turned into skills; they are reported as needing a reviewed tool integration.
 *  - A skill's status comes only from the validator (never from the model's claims).
 */
import { db } from "@/db";
import { skillAcquisitions } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { complete, modelAvailable, modelDiagnosis } from "@/lib/models/router";
import { researchTopic } from "@/lib/research";
import { createSkill, createDraftVersion, findSkills, promoteVersion, ensureCategory, USABLE, type NewSkillInput, type SkillStatus, type ValidationReport } from "@/lib/skills/registry";
import { isGranted } from "@/lib/permissions";
import { addMemory, recordExperience } from "@/lib/memory/store";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "@/lib/security";
import { errMsg, extractJson, slugify, truncate } from "@/lib/util";
import { recordMetric, logEvent } from "@/lib/log";
import { skills } from "@/db/schema";

type J = Record<string, unknown>;
const PHASES = ["IDENTIFY", "RESEARCH", "DECOMPOSE", "DEVELOP", "SANDBOX", "VALIDATE", "REGISTER", "IMPROVE"] as const;

async function patch(id: string, p: Partial<typeof skillAcquisitions.$inferInsert>) {
  await db.update(skillAcquisitions).set({ ...p, updatedAt: new Date() }).where(eq(skillAcquisitions.id, id));
}

async function addLog(id: string, phase: string, level: "info" | "warn" | "error", message: string, data?: J) {
  const [row] = await db.select().from(skillAcquisitions).where(eq(skillAcquisitions.id, id)).limit(1);
  if (!row) return;
  await patch(id, { phase, log: [...row.log, { at: new Date().toISOString(), phase, level, message, ...(data ? { data } : {}) }].slice(-80) });
}

async function setData(id: string, key: string, value: unknown) {
  const [row] = await db.select().from(skillAcquisitions).where(eq(skillAcquisitions.id, id)).limit(1);
  if (row) await patch(id, { data: { ...row.data, [key]: value } });
}

const NEEDS_HOST = /\b(download|upload|scrape|crawl|send (an )?(email|message|sms)|e-?mail|install|registry|screenshot|click|keyboard|mouse|microphone|camera|webcam|open (an )?app|launch|delete files?|write files?|read files?|http request|api call|fetch (a )?url|database|sql server|ssh|port scan)\b/i;

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/(encrypt|hash|password|vulnerab|malware|security|cipher)/i, "Cybersecurity"],
  [/(regress|classif|cluster|neural|machine learning|predict|model)/i, "Machine learning"],
  [/(csv|dataset|statistic|mean|median|dataframe|data)/i, "Data science"],
  [/(interest|loan|invest|finance|tax|stock|mortgage|currency)/i, "Financial analysis"],
  [/(convert|equation|algebra|geometry|calculus|prime|matrix|math|number)/i, "Mathematics"],
  [/(physics|chemistry|biology|molecule|experiment|scientific)/i, "Scientific research"],
  [/(translate|grammar|sentence|text|word|summar|language)/i, "Communication"],
  [/(android|apk|kotlin)/i, "Android development"],
  [/(windows|powershell|registry|batch)/i, "Windows automation"],
  [/(html|css|url|http|web|json|api)/i, "Web development"],
  [/(robot|servo|kinematic|pid)/i, "Robotics"],
  [/(lesson|quiz|teach|learn)/i, "Education"],
];

interface Spec {
  name: string;
  slug: string;
  description: string;
  category: string;
  searchQuery: string;
  risks: string[];
  feasible: boolean;
  infeasibleReason?: string;
}

function heuristicSpec(request: string): Spec {
  const core = request.replace(/^(please\s+)?(learn how to|learn to|create a skill to|build a skill to|develop a skill to|teach yourself to)\s+/i, "").trim();
  const name = truncate(core.charAt(0).toUpperCase() + core.slice(1), 60);
  const category = CATEGORY_HINTS.find(([re]) => re.test(request))?.[1] ?? "General problem-solving";
  const needsHost = NEEDS_HOST.test(request);
  return {
    name, slug: `custom.${slugify(core).slice(0, 40) || "skill"}`, description: `Skill requested by the user: ${core}`, category, searchQuery: core,
    risks: needsHost ? ["requires host or network access that sandboxed skills do not have"] : [], feasible: !needsHost,
    infeasibleReason: needsHost ? "This request needs host, file or network access. Sandboxed skills are pure computation, so it must be built as a reviewed tool integration instead." : undefined,
  };
}

async function modelSpec(request: string): Promise<Spec> {
  const base = heuristicSpec(request);
  const r = await complete("agent", {
    json: true, temperature: 0.1, maxTokens: 500,
    messages: [
      { role: "system", content: "You analyse capability requests for an AI assistant. Reply with JSON only: {\"name\":string,\"slug\":\"dotted.lowercase.id\",\"description\":string,\"category\":string,\"searchQuery\":string,\"risks\":string[],\"feasible\":boolean,\"infeasibleReason\":string}. A skill is a PURE synchronous JavaScript function (no network, no files, no OS access). Set feasible=false if the request needs I/O." },
      { role: "user", content: request },
    ],
  });
  const j = extractJson<Partial<Spec>>(r.text);
  if (!j) return base;
  return {
    name: String(j.name ?? base.name).slice(0, 80), slug: /^[a-z][a-z0-9_.-]{2,60}$/.test(String(j.slug)) ? String(j.slug) : base.slug,
    description: String(j.description ?? base.description).slice(0, 400), category: String(j.category ?? base.category).slice(0, 60),
    searchQuery: String(j.searchQuery ?? base.searchQuery).slice(0, 120), risks: Array.isArray(j.risks) ? j.risks.map(String).slice(0, 6) : [],
    feasible: j.feasible !== false && base.feasible, infeasibleReason: j.feasible === false ? String(j.infeasibleReason ?? base.infeasibleReason ?? "not feasible as a sandboxed skill") : base.infeasibleReason,
  };
}

export interface GeneratedSpec {
  code: string;
  inputSchema: J;
  outputSchema: J;
  tests: Array<{ name: string; input: unknown; expect?: unknown; expectError?: boolean | string }>;
  triggers: string[];
  limitations: string;
}

const CONTRACT = `Write a skill as PURE SYNCHRONOUS JavaScript (ES2017) defining exactly one entry point: function run(input) { ... } that returns a JSON-serialisable value or throws an Error with a clear message for invalid input.
FORBIDDEN (the sandbox rejects these): require, import, process, eval, Function constructor, constructor access, __proto__, globalThis, fetch, XMLHttpRequest, WebSocket, timers, async/await, Promises.
Validate every input field type defensively. Reply with JSON only:
{"code":"function run(input){...}","inputSchema":{type:"object",properties:{...},required:[...]},"outputSchema":{type:"object",properties:{...},required:[...]},"tests":[{"name":"...","input":{...},"expect":{...partial expected output...}},{"name":"...","input":{...},"expectError":"substring of error message"}],"triggers":["optional regex with named groups matching natural language requests, e.g. ^convert (?<value>\\\\d+) ..."],"limitations":"..."}
Provide at least 5 tests: normal cases, edge cases and at least 2 invalid-input cases using expectError. Compute expected values from the SPECIFICATION by hand, not from your code.`;

export async function generateSkillSpec(request: string, spec: Spec, researchContext: string, feedback?: { code: string; failures: string }): Promise<GeneratedSpec> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await complete("coding", {
      json: true, temperature: 0.2, maxTokens: 3000,
      messages: [
        { role: "system", content: `You are the ENGINEERING core of an AI system building a new sandboxed skill. ${CONTRACT}\n${UNTRUSTED_NOTICE}` },
        { role: "user", content: `Skill: ${spec.name}\nDescription: ${spec.description}\nOriginal request: ${request}\n${researchContext ? `\nReference material (untrusted):\n${researchContext}\n` : ""}${feedback ? `\nThe previous implementation FAILED validation. Fix it.\nPrevious code:\n${feedback.code}\nFailures:\n${feedback.failures}\n` : ""}${lastErr ? `\nYour previous reply was invalid: ${lastErr}. Return valid JSON exactly as specified.\n` : ""}` },
      ],
    }, { timeoutMs: 60_000 });
    const j = extractJson<Partial<GeneratedSpec>>(r.text);
    if (!j || typeof j.code !== "string" || !Array.isArray(j.tests)) { lastErr = "not valid JSON with code and tests"; continue; }
    return {
      code: j.code, inputSchema: (j.inputSchema as J) ?? {}, outputSchema: (j.outputSchema as J) ?? {},
      tests: (j.tests as GeneratedSpec["tests"]).slice(0, 20), triggers: Array.isArray(j.triggers) ? j.triggers.map(String).slice(0, 4) : [], limitations: String(j.limitations ?? ""),
    };
  }
  throw new Error(`model did not return a usable implementation (${lastErr})`);
}

export async function startAcquisition(request: string): Promise<string> {
  const [row] = await db.insert(skillAcquisitions).values({ request: request.slice(0, 600) }).returning({ id: skillAcquisitions.id });
  void run(row.id, request).catch(async (e) => {
    await addLog(row.id, "IDENTIFY", "error", `pipeline crashed: ${errMsg(e)}`);
    await patch(row.id, { status: "failed", error: errMsg(e) });
  });
  return row.id;
}

async function run(id: string, request: string) {
  if (!(await isGranted("skill.create"))) {
    await addLog(id, "IDENTIFY", "error", "capability skill.create is not granted");
    await patch(id, { status: "failed", error: "capability skill.create is not granted (Settings > Permissions)" });
    return;
  }
  const hasModel = await modelAvailable("coding");

  // 1 IDENTIFY
  await addLog(id, "IDENTIFY", "info", "Understanding the requested capability");
  const existing = await findSkills(request, 1);
  if (existing[0] && existing[0].score >= 0.6) {
    const s = existing[0].skill;
    await addLog(id, "IDENTIFY", "info", `A usable skill already covers this: ${s.slug} (${s.status}). Reusing instead of duplicating.`);
    await patch(id, { status: "completed", skillId: s.id, phase: "REGISTER", data: { reused: s.slug } });
    return;
  }
  let spec = heuristicSpec(request);
  if (hasModel) {
    try { spec = await modelSpec(request); } catch (e) { await addLog(id, "IDENTIFY", "warn", `model analysis failed (${errMsg(e)}); used heuristics`); }
  } else await addLog(id, "IDENTIFY", "warn", "No language model reachable; used keyword heuristics for analysis");
  await setData(id, "spec", spec as unknown as J);
  await addLog(id, "IDENTIFY", "info", `Capability: ${spec.name} [${spec.category}]. Risks: ${spec.risks.join("; ") || "none identified"}`);
  if (!spec.feasible) {
    await addLog(id, "IDENTIFY", "error", spec.infeasibleReason ?? "not feasible as a sandboxed skill");
    await patch(id, { status: "blocked", error: spec.infeasibleReason ?? "not feasible as a sandboxed skill" });
    return;
  }

  // 2 RESEARCH
  let researchContext = "";
  if (await isGranted("research.web")) {
    try {
      await addLog(id, "RESEARCH", "info", `Researching "${spec.searchQuery}" (official docs and reference sources are ranked first)`);
      const rr = await researchTopic(spec.searchQuery, { store: false, maxPages: 2 });
      await setData(id, "research", { sources: rr.sources.map((s) => ({ title: s.title, url: s.url, reliability: s.reliability })), summary: truncate(rr.summary, 800), warnings: rr.warnings.slice(0, 5) });
      researchContext = rr.sources.length ? wrapUntrusted(rr.summary, "research", 3000) : "";
      await addLog(id, "RESEARCH", rr.sources.length ? "info" : "warn", rr.sources.length ? `Collected ${rr.sources.length} source(s); reading about it is not the same as having a working implementation` : "No sources retrieved (offline or no results); continuing from the specification alone");
    } catch (e) { await addLog(id, "RESEARCH", "warn", `research failed: ${errMsg(e)}`); }
  } else await addLog(id, "RESEARCH", "warn", "web research not permitted; skipped");

  // 3 DECOMPOSE
  await addLog(id, "DECOMPOSE", "info", `Single reusable unit: ${spec.slug}`);
  await setData(id, "decomposition", [{ unit: spec.slug, purpose: spec.description }]);

  // 4 DEVELOP
  if (!hasModel) {
    const why = (await modelDiagnosis("coding")).join("; ");
    await addLog(id, "DEVELOP", "error", `Cannot generate an implementation: no language model is available (${why}). Provide GROQ_API_KEY, GEMINI_API_KEY or run Ollama, or submit your own implementation below - it will be sandboxed and validated identically.`);
    await patch(id, { status: "blocked", error: "needs a language model or a manual implementation" });
    return;
  }
  await addLog(id, "DEVELOP", "info", "Generating implementation, schemas and tests with the coding model");
  let gen: GeneratedSpec;
  try { gen = await generateSkillSpec(request, spec, researchContext); } catch (e) {
    await addLog(id, "DEVELOP", "error", errMsg(e));
    await patch(id, { status: "failed", error: errMsg(e) });
    return;
  }
  await finishRegistration(id, spec, gen, "generated");
}

export interface ManualSpec extends GeneratedSpec {
  name: string;
  slug: string;
  description: string;
  category: string;
}

export async function submitManualImplementation(id: string, m: ManualSpec) {
  const spec: Spec = { name: m.name, slug: m.slug, description: m.description, category: m.category, searchQuery: m.name, risks: [], feasible: true };
  await addLog(id, "DEVELOP", "info", "Manual implementation submitted by the user");
  await patch(id, { status: "running", error: null });
  await finishRegistration(id, spec, m, "manual");
}

async function finishRegistration(id: string, spec: Spec, gen: GeneratedSpec, origin: string) {
  const hasModel = await modelAvailable("coding");
  let slug = spec.slug;
  for (let i = 2; i < 20; i++) {
    const clash = await db.select({ id: skills.id }).from(skills).where(eq(skills.slug, slug)).limit(1);
    if (!clash.length) break;
    slug = `${spec.slug}-${i}`;
  }
  await ensureCategory(spec.category);
  const input: NewSkillInput = { slug, name: spec.name, description: spec.description, category: spec.category, code: gen.code, inputSchema: gen.inputSchema, outputSchema: gen.outputSchema, tests: gen.tests, triggers: gen.triggers, limitations: gen.limitations };
  await addLog(id, "SANDBOX", "info", "Testing in the isolated sandbox (separate process, no filesystem/network APIs, memory + time limits)");
  let created: { skillId: string; versionId: string; report: ValidationReport };
  try { created = await createSkill(input, origin, "DEVELOPING"); } catch (e) {
    await addLog(id, "REGISTER", "error", errMsg(e));
    await patch(id, { status: "failed", error: errMsg(e) });
    return;
  }
  let report = created.report;
  await patch(id, { skillId: created.skillId });
  await addLog(id, "VALIDATE", report.status === "FAILED" ? "warn" : "info", `Validation: ${report.status} (${report.summary.testsPassed}/${report.summary.testsTotal} tests, ${report.summary.checksPassed}/${report.summary.checksTotal} checks)`, { checks: report.checks as unknown as J[] });

  // 8 IMPROVE (bounded repair loop on failure)
  for (let i = 1; i <= 2 && report.status === "FAILED" && hasModel && origin === "generated"; i++) {
    const failures = [...report.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`), ...report.tests.filter((t) => !t.passed).map((t) => `test "${t.name}": ${t.detail}`)].join("\n");
    await addLog(id, "IMPROVE", "info", `Repair attempt ${i}: feeding validation failures back to the coding model`);
    try {
      const fixed = await generateSkillSpec(spec.description, spec, "", { code: gen.code, failures });
      const draft = await createDraftVersion(created.skillId, { code: fixed.code, inputSchema: fixed.inputSchema, outputSchema: fixed.outputSchema, tests: fixed.tests, triggers: fixed.triggers, limitations: fixed.limitations, changelog: `Repair attempt ${i}` }, "generated");
      gen = fixed;
      report = draft.report;
      await addLog(id, "IMPROVE", report.status === "FAILED" ? "warn" : "info", `Draft v${draft.version}: ${report.status}`);
      if (report.status === "TESTED" || report.status === "VERIFIED") {
        await promoteVersion(draft.versionId, "acquisition");
        await addLog(id, "IMPROVE", "info", `Promoted v${draft.version} (previous failed version is preserved in history)`);
      }
    } catch (e) { await addLog(id, "IMPROVE", "warn", `repair failed: ${errMsg(e)}`); break; }
  }

  const usable = USABLE.includes(report.status as SkillStatus);
  await addLog(id, "REGISTER", usable ? "info" : "error", usable ? `Registered ${slug} as ${report.status}. It can now be reused by name or trigger.` : `Registered ${slug} as ${report.status}. It is NOT usable until it passes validation.`);
  await patch(id, { status: usable ? "completed" : "failed", error: usable ? null : `final validation status ${report.status}` });
  await addMemory({ layer: "skill", title: `Skill: ${spec.name}`, content: `${spec.description}\nSlug: ${slug}\nCategory: ${spec.category}\nStatus: ${report.status}\nTests: ${report.summary.testsPassed}/${report.summary.testsTotal} passed\nOrigin: ${origin}`, tags: ["skill", slug], source: "system", force: true });
  await recordExperience(`Acquired skill ${slug}: ${report.status}`, `Request "${truncate(spec.description, 120)}" ended as ${report.status} after validation (${report.summary.testsPassed}/${report.summary.testsTotal} tests).`, ["skill-acquisition", slug]);
  void recordMetric("skill.acquisition", usable ? 1 : 0, { slug, status: report.status });
  void logEvent("info", "acquisition", `acquisition ${id} finished: ${report.status}`);
}

export async function getAcquisition(id: string) {
  const [row] = await db.select().from(skillAcquisitions).where(eq(skillAcquisitions.id, id)).limit(1);
  return row ? { ...row, phases: PHASES } : null;
}

export async function listAcquisitions() {
  return db.select().from(skillAcquisitions).orderBy(desc(skillAcquisitions.createdAt)).limit(20);
}

/** Phase 8 on demand: improve an existing skill from user feedback. Creates a DRAFT - never replaces silently. */
export async function improveSkill(skillId: string, feedback: string) {
  if (!(await modelAvailable("coding"))) throw new Error("improving a skill needs a language model; edit the draft manually instead");
  const { getSkillDetail } = await import("@/lib/skills/registry");
  const d = await getSkillDetail(skillId);
  if (!d) throw new Error("skill not found");
  const active = d.versions.find((v) => v.id === d.activeVersionId);
  if (!active) throw new Error("skill has no active version");
  const spec: Spec = { name: d.skill.name, slug: d.skill.slug, description: d.skill.description, category: d.skill.category, searchQuery: d.skill.name, risks: [], feasible: true };
  const gen = await generateSkillSpec(d.skill.description, spec, "", { code: active.code, failures: `User feedback: ${feedback}\nExisting tests: ${JSON.stringify(active.tests).slice(0, 1500)}` });
  const merged = [...(active.tests as GeneratedSpec["tests"]), ...gen.tests.filter((t) => !(active.tests as GeneratedSpec["tests"]).some((o) => o.name === t.name))];
  return createDraftVersion(skillId, { code: gen.code, inputSchema: gen.inputSchema, outputSchema: gen.outputSchema, tests: merged, triggers: gen.triggers.length ? gen.triggers : active.triggers, limitations: gen.limitations, changelog: `Improvement: ${truncate(feedback, 100)}` }, "generated");
}
