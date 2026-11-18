/**
 * Skill registry + validator.
 *
 * Status ladder (a status is only ever set by the validator from real sandbox results):
 *   EXPERIMENTAL - created, never (successfully) tested or has no tests
 *   DEVELOPING   - being built by the acquisition pipeline
 *   TESTED       - all defined tests pass
 *   VERIFIED     - tests pass AND >=3 tests incl. an error case, invalid-input robustness,
 *                  resource limits and output-schema conformance all pass
 *   FAILED       - static scan, a test, robustness or resource check failed
 *   DISABLED     - switched off by the user
 *
 * Updating a skill never replaces it silently: a new version is created as a draft, tested, and
 * must be promoted explicitly. Rollback re-validates the target version before activating it.
 */
import { db } from "@/db";
import { skillCategories, skillVersions, skills } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { runInSandbox } from "@/lib/sandbox";
import { scanCode, type CodeFinding } from "@/lib/security";
import { coerceToSchema, matchSubset, validateSchema, type Schema, type SkillTestCase } from "@/lib/skills/schema";
import { BUILTIN_CATEGORIES, SEED_SKILLS } from "@/lib/skills/seeds";
import { audit, logEvent, recordMetric } from "@/lib/log";
import { recordExperience } from "@/lib/memory/store";
import { errMsg } from "@/lib/util";
import { tokenizeText } from "@/lib/memory/embedding";

export type SkillStatus = "EXPERIMENTAL" | "DEVELOPING" | "TESTED" | "VERIFIED" | "FAILED" | "DISABLED";
export const USABLE: SkillStatus[] = ["TESTED", "VERIFIED"];
const RANK: Record<string, number> = { FAILED: 0, EXPERIMENTAL: 1, DEVELOPING: 1, DISABLED: 0, TESTED: 2, VERIFIED: 3 };

export interface ValidationReport {
  ranAt: string;
  status: SkillStatus;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  tests: Array<{ name: string; passed: boolean; detail: string; durationMs: number }>;
  resources: { maxDurationMs: number; maxHeapMb: number; maxCpuMs: number };
  summary: { testsPassed: number; testsTotal: number; checksPassed: number; checksTotal: number };
  findings: CodeFinding[];
}

type SkillRow = typeof skills.$inferSelect;
type VersionRow = typeof skillVersions.$inferSelect;

// ---------------------------------------------------------------- validator
export async function validateCode(a: { code: string; tests: SkillTestCase[]; inputSchema: Schema; outputSchema: Schema }): Promise<ValidationReport> {
  const checks: ValidationReport["checks"] = [];
  const tests: ValidationReport["tests"] = [];
  const resources = { maxDurationMs: 0, maxHeapMb: 0, maxCpuMs: 0 };
  const scan = scanCode(a.code);
  checks.push({
    name: "security_scan",
    passed: scan.ok,
    detail: scan.ok ? `no forbidden constructs (${scan.findings.length} warnings)` : scan.findings.filter((f) => f.severity === "critical").map((f) => f.message).join("; "),
  });
  const finish = (status: SkillStatus): ValidationReport => ({
    ranAt: new Date().toISOString(),
    status,
    checks,
    tests,
    resources,
    findings: scan.findings,
    summary: {
      testsPassed: tests.filter((t) => t.passed).length,
      testsTotal: tests.length,
      checksPassed: checks.filter((c) => c.passed).length,
      checksTotal: checks.length,
    },
  });
  if (!scan.ok) return finish("FAILED"); // dangerous code is never executed, not even in the sandbox

  const list = (a.tests ?? []).filter((t) => t && typeof t.name === "string");
  checks.push({ name: "has_tests", passed: list.length > 0, detail: `${list.length} test case(s) defined` });
  if (list.length === 0) return finish("EXPERIMENTAL");

  const track = (r: { durationMs: number; heapMb: number; cpuMs: number }) => {
    resources.maxDurationMs = Math.max(resources.maxDurationMs, Math.round(r.durationMs));
    resources.maxHeapMb = Math.max(resources.maxHeapMb, Math.round(r.heapMb * 10) / 10);
    resources.maxCpuMs = Math.max(resources.maxCpuMs, Math.round(r.cpuMs));
  };

  let schemaViolations = 0;
  const results = await Promise.all(
    list.map(async (t) => {
      const r = await runInSandbox({ code: a.code, input: t.input, timeoutMs: 2000 });
      track(r);
      let passed = false;
      let detail = "";
      if (t.expectError) {
        if (r.timedOut || r.crashed) detail = `expected a handled error but got ${r.timedOut ? "timeout" : "crash"}`;
        else if (r.ok) detail = `expected an error but got output ${JSON.stringify(r.value).slice(0, 120)}`;
        else if (typeof t.expectError === "string" && !String(r.error).toLowerCase().includes(t.expectError.toLowerCase()))
          detail = `error "${r.error}" does not contain "${t.expectError}"`;
        else {
          passed = true;
          detail = `rejected as expected: ${r.error}`;
        }
      } else if (!r.ok) {
        detail = `unexpected error: ${r.error}`;
      } else {
        const inErr = validateSchema(a.inputSchema, t.input);
        const outErr = validateSchema(a.outputSchema, r.value);
        if (t.expect !== undefined && !matchSubset(r.value, t.expect)) detail = `output ${JSON.stringify(r.value).slice(0, 160)} does not match expected ${JSON.stringify(t.expect).slice(0, 160)}`;
        else if (inErr.length) detail = `test input violates the declared input schema: ${inErr[0]}`;
        else if (outErr.length) {
          schemaViolations++;
          detail = `output violates the declared output schema: ${outErr[0]}`;
        } else {
          passed = true;
          detail = "output matches";
        }
      }
      return { name: t.name, passed, detail, durationMs: Math.round(r.durationMs) };
    }),
  );
  tests.push(...results);

  const garbage: unknown[] = [null, "garbage", 42, [], {}];
  const robust = await Promise.all(garbage.map((g) => runInSandbox({ code: a.code, input: g, timeoutMs: 1500 })));
  robust.forEach(track);
  const bad = robust.filter((r) => r.timedOut || r.crashed).length;
  checks.push({ name: "invalid_input_robustness", passed: bad === 0, detail: bad === 0 ? "5/5 malformed inputs handled without crash or hang" : `${bad}/5 malformed inputs caused a crash or timeout` });

  const resOk = resources.maxDurationMs < 1000 && resources.maxHeapMb < 48;
  checks.push({ name: "resource_limits", passed: resOk, detail: `max ${resources.maxDurationMs} ms, heap ${resources.maxHeapMb} MB, cpu ${resources.maxCpuMs} ms` });
  const hasOutSchema = !!a.outputSchema && Object.keys(a.outputSchema).length > 0;
  checks.push({ name: "output_schema", passed: hasOutSchema && schemaViolations === 0, detail: !hasOutSchema ? "no output schema declared" : schemaViolations ? `${schemaViolations} output(s) violate the schema` : "all outputs conform" });

  const allTestsPass = tests.every((t) => t.passed);
  const hasErrorCase = list.some((t) => t.expectError);
  if (!allTestsPass || bad > 0 || !resOk) return finish("FAILED");
  checks.push({ name: "coverage", passed: list.length >= 3 && hasErrorCase, detail: `${list.length} tests, error case ${hasErrorCase ? "present" : "missing"} (VERIFIED needs >=3 tests incl. an error case)` });
  const verified = list.length >= 3 && hasErrorCase && checks.every((c) => c.passed);
  return finish(verified ? "VERIFIED" : "TESTED");
}

// ---------------------------------------------------------------- seeding
let seeding: Promise<void> | null = null;

export function ensureSeeded(): Promise<void> {
  if (!seeding) {
    seeding = seed().catch((e) => {
      seeding = null;
      void logEvent("error", "skills", `seeding failed: ${errMsg(e)}`);
    });
  }
  return seeding;
}

async function seed() {
  for (const [name, description] of BUILTIN_CATEGORIES) {
    await db.insert(skillCategories).values({ name, description, builtin: true }).onConflictDoNothing();
  }
  const pending: string[] = [];
  for (const s of SEED_SKILLS) {
    const existing = await db.select().from(skills).where(eq(skills.slug, s.slug)).limit(1);
    if (existing.length) continue;
    const [skill] = await db.insert(skills).values({ slug: s.slug, name: s.name, description: s.description, category: s.category, builtin: true }).returning();
    const [ver] = await db
      .insert(skillVersions)
      .values({
        skillId: skill.id, version: 1, code: s.code.trim(), inputSchema: s.inputSchema, outputSchema: s.outputSchema,
        tests: s.tests as unknown as Record<string, unknown>[], triggers: s.triggers, limitations: s.limitations, permissions: ["sandbox"], dependencies: [],
        origin: "builtin", changelog: "Built-in skill",
      })
      .returning();
    await db.update(skills).set({ activeVersionId: ver.id }).where(eq(skills.id, skill.id));
    pending.push(ver.id);
  }
  // Statuses are earned: run the real validation for every new built-in skill.
  for (const id of pending) await testVersion(id).catch(() => undefined);
  // Re-validate any built-in whose active version was never validated (e.g. interrupted first run).
  const unvalidated = await db.select({ id: skillVersions.id, skillId: skillVersions.skillId }).from(skillVersions).where(eq(skillVersions.origin, "builtin"));
  for (const v of unvalidated) {
    const [full] = await db.select({ validation: skillVersions.validation }).from(skillVersions).where(eq(skillVersions.id, v.id));
    if (!full.validation) await testVersion(v.id).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- queries
export interface SkillSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  status: SkillStatus;
  enabled: boolean;
  builtin: boolean;
  usageCount: number;
  successCount: number;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  versionId: string | null;
  versionsCount: number;
  dependencies: string[];
  permissions: string[];
  triggers: string[];
  limitations: string;
  executionMethod: string;
  implementation: string;
  testsCount: number;
  validation: ValidationReport | null;
  testedAt: Date | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

function summarize(s: SkillRow, v: VersionRow | undefined, versionsCount: number): SkillSummary {
  return {
    id: s.id, slug: s.slug, name: s.name, description: s.description, category: s.category,
    status: s.enabled ? (s.status as SkillStatus) : "DISABLED", enabled: s.enabled, builtin: s.builtin,
    usageCount: s.usageCount, successCount: s.successCount, failureCount: s.failureCount, createdAt: s.createdAt, updatedAt: s.updatedAt,
    version: v?.version ?? 0, versionId: v?.id ?? null, versionsCount,
    dependencies: v?.dependencies ?? [], permissions: v?.permissions ?? [], triggers: v?.triggers ?? [], limitations: v?.limitations ?? "",
    executionMethod: v?.executionMethod ?? "sandbox-js", implementation: v ? `skill_versions/${v.id} (${v.executionMethod})` : "none",
    testsCount: v?.tests.length ?? 0, validation: (v?.validation as unknown as ValidationReport) ?? null, testedAt: v?.testedAt ?? null,
    inputSchema: v?.inputSchema ?? {}, outputSchema: v?.outputSchema ?? {},
  };
}

export async function listSkills(): Promise<SkillSummary[]> {
  await ensureSeeded();
  const rows = await db.select().from(skills).orderBy(skills.category, skills.name);
  const versions = await db.select().from(skillVersions);
  return rows.map((s) => {
    const mine = versions.filter((v) => v.skillId === s.id);
    return summarize(s, mine.find((v) => v.id === s.activeVersionId), mine.length);
  });
}

export async function listCategories() {
  await ensureSeeded();
  return db.select().from(skillCategories).orderBy(skillCategories.name);
}

export async function getSkillDetail(idOrSlug: string) {
  await ensureSeeded();
  const isId = /^[0-9a-f-]{36}$/i.test(idOrSlug);
  const [s] = await db.select().from(skills).where(isId ? eq(skills.id, idOrSlug) : eq(skills.slug, idOrSlug)).limit(1);
  if (!s) return null;
  const versions = await db.select().from(skillVersions).where(eq(skillVersions.skillId, s.id)).orderBy(desc(skillVersions.version));
  const active = versions.find((v) => v.id === s.activeVersionId);
  return { skill: summarize(s, active, versions.length), versions, activeVersionId: s.activeVersionId };
}

// ---------------------------------------------------------------- mutations
export interface NewSkillInput {
  slug: string;
  name: string;
  description: string;
  category: string;
  code: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tests?: SkillTestCase[];
  triggers?: string[];
  dependencies?: string[];
  limitations?: string;
}

const SLUG_RE = /^[a-z][a-z0-9_.-]{2,60}$/;

export function checkTriggers(triggers: string[]): string | null {
  for (const t of triggers) {
    if (t.length > 400) return "trigger pattern too long";
    try {
      new RegExp(t, "i");
    } catch {
      return `invalid trigger regex: ${t}`;
    }
  }
  return null;
}

export async function ensureCategory(name: string, description = "") {
  await db.insert(skillCategories).values({ name, description: description || "Created dynamically" }).onConflictDoNothing();
}

export async function createSkill(input: NewSkillInput, origin = "manual", status: SkillStatus = "EXPERIMENTAL") {
  await ensureSeeded();
  if (!SLUG_RE.test(input.slug)) throw new Error("slug must be 3-61 chars: lowercase letters, digits, '.', '_' or '-', starting with a letter");
  if (!input.name?.trim() || !input.description?.trim() || !input.code?.trim()) throw new Error("name, description and code are required");
  const trig = checkTriggers(input.triggers ?? []);
  if (trig) throw new Error(trig);
  const dup = await db.select({ id: skills.id }).from(skills).where(eq(skills.slug, input.slug)).limit(1);
  if (dup.length) throw new Error(`a skill with slug "${input.slug}" already exists - create a new version instead of replacing it`);
  const category = input.category?.trim() || "General problem-solving";
  await ensureCategory(category);
  const [skill] = await db
    .insert(skills)
    .values({ slug: input.slug, name: input.name.trim(), description: input.description.trim(), category, status })
    .returning();
  const [ver] = await db
    .insert(skillVersions)
    .values({
      skillId: skill.id, version: 1, code: input.code, inputSchema: input.inputSchema ?? {}, outputSchema: input.outputSchema ?? {},
      tests: (input.tests ?? []) as unknown as Record<string, unknown>[], triggers: input.triggers ?? [], dependencies: input.dependencies ?? [],
      permissions: ["sandbox"], limitations: input.limitations ?? "", origin, status, changelog: "Initial version",
    })
    .returning();
  await db.update(skills).set({ activeVersionId: ver.id }).where(eq(skills.id, skill.id));
  await audit({ actor: origin === "manual" ? "user" : origin, action: "skill.create", tool: skill.slug, risk: "MEDIUM", decision: "allowed" });
  const report = await testVersion(ver.id);
  return { skillId: skill.id, versionId: ver.id, report };
}

export async function createDraftVersion(
  skillId: string,
  patch: Partial<Pick<NewSkillInput, "code" | "inputSchema" | "outputSchema" | "tests" | "triggers" | "dependencies" | "limitations">> & { changelog?: string },
  origin = "manual",
) {
  const [s] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!s) throw new Error("skill not found");
  const [active] = await db.select().from(skillVersions).where(eq(skillVersions.id, s.activeVersionId ?? "00000000-0000-0000-0000-000000000000")).limit(1);
  const latest = await db.select({ v: skillVersions.version }).from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version)).limit(1);
  const trig = checkTriggers(patch.triggers ?? active?.triggers ?? []);
  if (trig) throw new Error(trig);
  const [ver] = await db
    .insert(skillVersions)
    .values({
      skillId, version: (latest[0]?.v ?? 0) + 1,
      code: patch.code ?? active?.code ?? "", inputSchema: patch.inputSchema ?? active?.inputSchema ?? {}, outputSchema: patch.outputSchema ?? active?.outputSchema ?? {},
      tests: ((patch.tests as unknown as Record<string, unknown>[]) ?? active?.tests ?? []), triggers: patch.triggers ?? active?.triggers ?? [],
      dependencies: patch.dependencies ?? active?.dependencies ?? [], permissions: ["sandbox"], limitations: patch.limitations ?? active?.limitations ?? "",
      origin, status: "EXPERIMENTAL", changelog: patch.changelog ?? "Draft version",
    })
    .returning();
  await audit({ actor: origin === "manual" ? "user" : origin, action: "skill.draft", tool: s.slug, risk: "MEDIUM", decision: "allowed", details: { version: ver.version } });
  const report = await testVersion(ver.id);
  return { versionId: ver.id, version: ver.version, report };
}

export async function testVersion(versionId: string): Promise<ValidationReport> {
  const [v] = await db.select().from(skillVersions).where(eq(skillVersions.id, versionId)).limit(1);
  if (!v) throw new Error("version not found");
  const report = await validateCode({ code: v.code, tests: v.tests as unknown as SkillTestCase[], inputSchema: v.inputSchema as Schema, outputSchema: v.outputSchema as Schema });
  await db.update(skillVersions).set({ status: report.status, validation: report as unknown as Record<string, unknown>, testedAt: new Date() }).where(eq(skillVersions.id, versionId));
  const [s] = await db.select().from(skills).where(eq(skills.id, v.skillId)).limit(1);
  if (s && s.activeVersionId === versionId) await db.update(skills).set({ status: report.status, updatedAt: new Date() }).where(eq(skills.id, s.id));
  void recordMetric("skill.validation", report.status === "VERIFIED" || report.status === "TESTED" ? 1 : 0, { slug: s?.slug, status: report.status });
  if (report.status === "FAILED" && s) {
    const failing = [...report.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`), ...report.tests.filter((t) => !t.passed).map((t) => `test "${t.name}": ${t.detail}`)].slice(0, 5);
    await recordExperience(`Skill ${s.slug} v${v.version} failed validation`, `Failures: ${failing.join(" | ")}. Fix these before promoting the version.`, ["skill", s.slug, "validation"]);
  }
  return report;
}

export async function promoteVersion(versionId: string, actor = "user") {
  const [v] = await db.select().from(skillVersions).where(eq(skillVersions.id, versionId)).limit(1);
  if (!v) throw new Error("version not found");
  const [s] = await db.select().from(skills).where(eq(skills.id, v.skillId)).limit(1);
  if (!s) throw new Error("skill not found");
  if (!USABLE.includes(v.status as SkillStatus)) throw new Error(`only TESTED or VERIFIED versions can be promoted (this one is ${v.status})`);
  const [active] = s.activeVersionId ? await db.select().from(skillVersions).where(eq(skillVersions.id, s.activeVersionId)).limit(1) : [];
  if (active && active.id !== v.id && RANK[v.status] < RANK[active.status]) throw new Error(`candidate (${v.status}) is weaker than the active version (${active.status}); refusing to replace a better skill`);
  await db.update(skills).set({ activeVersionId: v.id, status: v.status, updatedAt: new Date() }).where(eq(skills.id, s.id));
  await audit({ actor, action: "skill.promote", tool: s.slug, risk: "MEDIUM", decision: "allowed", details: { from: active?.version, to: v.version } });
  return { slug: s.slug, version: v.version, status: v.status };
}

export async function rollbackSkill(skillId: string, targetVersionId?: string, actor = "user") {
  const [s] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!s) throw new Error("skill not found");
  const versions = await db.select().from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version));
  const target = targetVersionId
    ? versions.find((v) => v.id === targetVersionId)
    : versions.find((v) => v.id !== s.activeVersionId && USABLE.includes(v.status as SkillStatus));
  if (!target) throw new Error("no earlier TESTED/VERIFIED version to roll back to");
  const report = await testVersion(target.id); // never activate something that no longer passes
  if (!USABLE.includes(report.status)) throw new Error(`version ${target.version} no longer passes validation (${report.status}); rollback refused`);
  await db.update(skills).set({ activeVersionId: target.id, status: report.status, updatedAt: new Date() }).where(eq(skills.id, skillId));
  await audit({ actor, action: "skill.rollback", tool: s.slug, risk: "MEDIUM", decision: "allowed", details: { to: target.version } });
  return { slug: s.slug, version: target.version, status: report.status };
}

/** User-initiated removal of a user-created skill (built-ins can only be disabled). */
export async function deleteSkill(skillId: string, actor = "user") {
  const [s] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!s) throw new Error("skill not found");
  if (s.builtin) throw new Error("built-in skills cannot be deleted; disable them instead");
  await db.delete(skillVersions).where(eq(skillVersions.skillId, skillId));
  await db.delete(skills).where(eq(skills.id, skillId));
  await audit({ actor, action: "skill.delete", tool: s.slug, risk: "HIGH", decision: "allowed" });
}

export async function setSkillEnabled(skillId: string, enabled: boolean, actor = "user") {
  const [s] = await db.update(skills).set({ enabled, updatedAt: new Date() }).where(eq(skills.id, skillId)).returning();
  if (!s) throw new Error("skill not found");
  await audit({ actor, action: enabled ? "skill.enable" : "skill.disable", tool: s.slug, risk: "MEDIUM", decision: "allowed" });
  return s;
}

// ---------------------------------------------------------------- execution + matching
export interface SkillRunResult {
  ok: boolean;
  slug: string;
  version?: number;
  status?: SkillStatus;
  output?: unknown;
  error?: string;
  durationMs?: number;
  untested?: boolean;
}

export async function runSkill(slug: string, input: unknown, opts: { allowUntested?: boolean; actor?: string } = {}): Promise<SkillRunResult> {
  await ensureSeeded();
  const [s] = await db.select().from(skills).where(eq(skills.slug, slug)).limit(1);
  if (!s) return { ok: false, slug, error: `no skill named ${slug}` };
  if (!s.enabled) return { ok: false, slug, error: "skill is disabled" };
  const [v] = s.activeVersionId ? await db.select().from(skillVersions).where(eq(skillVersions.id, s.activeVersionId)).limit(1) : [];
  if (!v) return { ok: false, slug, error: "skill has no active version" };
  const status = s.status as SkillStatus;
  const untested = !USABLE.includes(status);
  if (untested && !opts.allowUntested) return { ok: false, slug, version: v.version, status, error: `skill is ${status}; only TESTED or VERIFIED skills run automatically` };
  const inErr = validateSchema(v.inputSchema as Schema, input);
  if (inErr.length) return { ok: false, slug, version: v.version, status, error: `invalid input: ${inErr.slice(0, 3).join("; ")}` };
  const r = await runInSandbox({ code: v.code, input, timeoutMs: 3000 });
  let ok = r.ok;
  let error = r.error;
  if (ok) {
    const outErr = validateSchema(v.outputSchema as Schema, r.value);
    if (outErr.length) {
      ok = false;
      error = `output violated schema: ${outErr[0]}`;
    }
  }
  await db
    .update(skills)
    .set({ usageCount: s.usageCount + 1, successCount: s.successCount + (ok ? 1 : 0), failureCount: s.failureCount + (ok ? 0 : 1) })
    .where(eq(skills.id, s.id));
  void recordMetric("skill.run", ok ? 1 : 0, { slug, durationMs: Math.round(r.durationMs), error: ok ? undefined : error, input: ok ? undefined : JSON.stringify(input ?? null).slice(0, 300) });
  await audit({ actor: opts.actor ?? "core", action: "skill.run", tool: slug, risk: "LOW", decision: ok ? "ok" : "error", details: { version: v.version, error } });
  if (!ok && (r.timedOut || r.crashed)) await recordExperience(`Skill ${slug} ${r.timedOut ? "timed out" : "crashed"}`, `Input ${JSON.stringify(input).slice(0, 200)} caused: ${error}`, ["skill", slug, "runtime"]);
  return { ok, slug, version: v.version, status, output: ok ? r.value : undefined, error, durationMs: Math.round(r.durationMs), untested };
}

export interface TriggerMatch {
  slug: string;
  name: string;
  input: Record<string, unknown>;
}

export async function matchSkillByTrigger(text: string): Promise<TriggerMatch | null> {
  await ensureSeeded();
  const t = text.trim();
  if (t.length === 0 || t.length > 1500) return null;
  const rows = await db
    .select({ slug: skills.slug, name: skills.name, triggers: skillVersions.triggers, inputSchema: skillVersions.inputSchema })
    .from(skills)
    .innerJoin(skillVersions, eq(skills.activeVersionId, skillVersions.id))
    .where(and(eq(skills.enabled, true)));
  const usable = await db.select({ slug: skills.slug, status: skills.status }).from(skills);
  const okSlugs = new Set(usable.filter((u) => USABLE.includes(u.status as SkillStatus)).map((u) => u.slug));
  for (const r of rows) {
    if (!okSlugs.has(r.slug)) continue;
    for (const pattern of r.triggers) {
      if (pattern.length > 400) continue;
      let m: RegExpExecArray | null = null;
      try {
        m = new RegExp(pattern, "i").exec(t);
      } catch {
        continue;
      }
      if (m && m.groups) return { slug: r.slug, name: r.name, input: coerceToSchema(r.inputSchema as Schema, m.groups) };
    }
  }
  return null;
}

/** Keyword search over skill metadata, restricted to skills that can actually run. */
export async function findSkills(query: string, limit = 3, usableOnly = true) {
  const all = await listSkills();
  const q = new Set(tokenizeText(query));
  return all
    .filter((s) => s.enabled && (!usableOnly || USABLE.includes(s.status)))
    .map((s) => {
      const doc = new Set(tokenizeText(`${s.name} ${s.description} ${s.slug.replace(/[._]/g, " ")} ${s.category}`));
      let hit = 0;
      for (const t of q) if (doc.has(t)) hit++;
      return { skill: s, score: q.size ? hit / q.size : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
