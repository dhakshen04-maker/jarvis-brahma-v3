/**
 * BRAHMA CORE - the central orchestrator.
 *
 * OBSERVE (sanitise, redact secrets) -> UNDERSTAND (deterministic intent routing, then skill triggers)
 * -> ANALYZE/PLAN (engine selection, model routing) -> DELEGATE (agents / acquisition) -> EXECUTE
 * (permission-gated tools, sandboxed skills) -> TEST/VERIFY (validators, critic) -> LEARN (metrics,
 * experience memory, capability-gap tracking).
 *
 * Tool use is only ever triggered by the user's own words through deterministic patterns, never by model
 * output or external content, so prompt injection cannot cause actions.
 */
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { NoModelError, complete, modelAvailable, modelDiagnosis, streamChat } from "@/lib/models/router";
import type { ChatMessage, TaskKind } from "@/lib/models/providers";
import { invokeTool, type ToolOutcome } from "@/lib/tools";
import { allowedApps } from "@/lib/tools/system";
import { findSkills, listSkills, matchSkillByTrigger, runSkill, USABLE } from "@/lib/skills/registry";
import { validateSchema, type Schema } from "@/lib/skills/schema";
import { getAcquisition, listAcquisitions, startAcquisition } from "@/lib/skills/acquisition";
import { getRun, startRun } from "@/lib/agents";
import { analyze, evolutionReport } from "@/lib/evolution";
import { engineerDiagnose, markEngine, scholarClassify, securityAudit, translateText } from "@/lib/engines";
import { relevantContext, memoryStats } from "@/lib/memory/store";
import { detectSecrets, redactSecrets, UNTRUSTED_NOTICE } from "@/lib/security";
import { detectLanguage } from "@/lib/languages";
import { recordMetric } from "@/lib/log";
import { errMsg, extractJson, truncate } from "@/lib/util";

export type CoreEvent =
  | { t: "phase"; phase: "understanding" | "thinking" | "executing" }
  | { t: "intent"; intent: string; engine: string }
  | { t: "tool"; name: string; status: string; risk: string; detail?: string }
  | { t: "delta"; text: string }
  | { t: "approval"; approval: { id: string; tool: string; risk: string; summary: string; expiresAt: string } }
  | { t: "data"; kind: string; payload: unknown }
  | { t: "done"; text: string; meta: Record<string, unknown> };

type Intent =
  | { kind: "remember"; text: string }
  | { kind: "recall"; query: string }
  | { kind: "forget"; query: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "skill_trigger"; slug: string; name: string; input: Record<string, unknown> }
  | { kind: "skill_list" }
  | { kind: "acquire"; request: string }
  | { kind: "acquire_status" }
  | { kind: "research"; topic: string }
  | { kind: "agents"; goal: string }
  | { kind: "diagnose" }
  | { kind: "security_audit" }
  | { kind: "translate"; target: string; text: string }
  | { kind: "evolve" }
  | { kind: "capabilities" }
  | { kind: "chat" };

async function classify(raw: string): Promise<Intent> {
  const t = raw.replace(/[.!]+$/, "").trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(?:please\s+)?(?:remember|memori[sz]e|make a note|store)(?:\s+that)?[:\s]+(.+)$/i))) return { kind: "remember", text: m[1] };
  if ((m = t.match(/^(?:what do you (?:remember|know) about|do you remember|recall)\s+(.+?)\??$/i))) return { kind: "recall", query: m[1] };
  if ((m = t.match(/^(?:forget|delete (?:the )?memory (?:about|of))\s+(?:about\s+)?(.+)$/i))) return { kind: "forget", query: m[1] };
  if (/^(?:cpu|ram|memory|resource) usage\??$|^how (?:busy|loaded) is (?:my |the )?(?:cpu|system)\??$/i.test(t)) return { kind: "tool", name: "system.resources", args: {} };
  if (/^system info(?:rmation)?\??$/i.test(t)) return { kind: "tool", name: "system.info", args: {} };
  if (/^(?:list|show)(?: the)? (?:running )?processes\??$/i.test(t)) return { kind: "tool", name: "process.list", args: {} };
  if ((m = t.match(/^(?:kill|terminate) process (\d+)$/i))) return { kind: "tool", name: "process.kill", args: { pid: Number(m[1]) } };
  if ((m = t.match(/^(?:list|show) files?(?: in (.+))?$/i))) return { kind: "tool", name: "fs.list", args: { path: m[1] ?? "." } };
  if ((m = t.match(/^read file (.+)$/i))) return { kind: "tool", name: "fs.read", args: { path: m[1] } };
  if ((m = t.match(/^search files? (?:for )?(.+)$/i))) return { kind: "tool", name: "fs.search", args: { query: m[1] } };
  if ((m = t.match(/^(?:create|make) (?:a )?(?:folder|directory) (.+)$/i))) return { kind: "tool", name: "fs.mkdir", args: { path: m[1] } };
  if ((m = t.match(/^(?:create|write) file ([^\s:]+)\s*(?:with content|containing)?\s*:?\s*([\s\S]+)$/i))) return { kind: "tool", name: "fs.write", args: { path: m[1], content: m[2] } };
  if ((m = t.match(/^delete file (.+)$/i))) return { kind: "tool", name: "fs.delete", args: { path: m[1] } };
  if ((m = t.match(/^restore file (\S+)$/i))) return { kind: "tool", name: "fs.restore", args: { trashId: m[1] } };
  if ((m = t.match(/^run script (\S+)(?:\s+(.*))?$/i))) return { kind: "tool", name: "script.run", args: { file: m[1], args: m[2] ? m[2].split(/\s+/) : [] } };
  if ((m = t.match(/^(?:notify|send (?:a )?notification to) (?:my )?(?:phone|android)[:\s]+(.+)$/i))) return { kind: "tool", name: "android.notify", args: { message: m[1] } };
  if ((m = t.match(/^launch (.+?) on (?:my )?(?:phone|android)$/i))) return { kind: "tool", name: "android.launch_app", args: { app: m[1] } };
  if ((m = t.match(/^open (?:the )?(.+?)(?: app| application)?$/i)) && allowedApps().includes(m[1].toLowerCase())) return { kind: "tool", name: "app.open", args: { name: m[1] } };
  if (/^(?:what(?:'s| is)(?: the)?(?: current)? (?:time|date)|what time is it|current time|what(?:'s| is) today'?s? date|time|date)\??$/i.test(t)) return { kind: "tool", name: "time.now", args: {} };
  if (/^(?:security audit|audit (?:the )?security|run a security (?:check|audit))$/i.test(t)) return { kind: "security_audit" };
  if (/^(?:diagnose|check)(?: the| my)? (?:system|pc|computer)|^why is (?:my |the )?(?:pc|computer|system) slow|^system (?:status|health)/i.test(t)) return { kind: "diagnose" };
  if (/^(?:self[- ]evaluat\w*|evolve|analy[sz]e (?:your|my) performance|run self[- ]evaluation)$/i.test(t)) return { kind: "evolve" };
  if (/^(?:skill )?acquisition status|^how is the skill (?:coming|going)/i.test(t)) return { kind: "acquire_status" };
  const trig = await matchSkillByTrigger(t);
  if (trig) return { kind: "skill_trigger", slug: trig.slug, name: trig.name, input: trig.input };
  if (/^(?:list|show)?\s*(?:my |your )?skills\??$|^what skills do you have/i.test(t)) return { kind: "skill_list" };
  if ((m = t.match(/^(?:please\s+)?(?:learn(?: how)? to|(?:create|build|develop) a skill (?:to|that|for)|acquire (?:the )?skill (?:to|of)|teach yourself(?: to| how to)?)\s+(.+)$/i))) return { kind: "acquire", request: m[1] };
  if ((m = t.match(/^(?:research|investigate|look up|search the web for|search web for|find out about|learn about|study)\s+(.+)$/i))) return { kind: "research", topic: m[1] };
  if (/^(?:delegate|run agents?|use the agents)\b|^audit skill\s+\S+|^(?:build|create|develop) (?:a )?skill\b/i.test(t)) return { kind: "agents", goal: t.replace(/^(?:delegate:?|run agents? (?:on|for)|use the agents to)\s*/i, "") };
  if ((m = t.match(/^translate (?:to|into) ([\p{L} ]+?)[:\s]+(.+)$/iu))) return { kind: "translate", target: m[1], text: m[2] };
  if ((m = t.match(/^translate (.+?) (?:to|into) ([\p{L}]+)$/iu))) return { kind: "translate", target: m[2], text: m[1] };
  if (/^(?:what can you do|help|capabilities|commands|what are your capabilities)\??$/i.test(t)) return { kind: "capabilities" };
  return { kind: "chat" };
}

function engineFor(i: Intent, text: string): string {
  switch (i.kind) {
    case "remember": case "recall": case "forget": return "memory";
    case "acquire": case "acquire_status": return "creator";
    case "research": return "research";
    case "agents": return "strategist";
    case "diagnose": return "engineer";
    case "security_audit": return "security";
    case "translate": return "communicator";
    case "evolve": return "evolution";
    case "skill_list": case "skill_trigger": return "engineer";
    case "tool": return i.name.startsWith("memory") ? "memory" : "engineer";
    case "capabilities": return "communicator";
    default: return scholarClassify(text).discipline ? "scholar" : "communicator";
  }
}

function pickTask(text: string): TaskKind {
  if (/\b(translate|in (tamil|hindi|french|spanish|german))\b/i.test(text)) return "translation";
  if (/\b(code|function|bug|stack ?trace|script|regex|sql|python|javascript|typescript|compile|refactor|kotlin|powershell)\b/i.test(text)) return "coding";
  if (text.length > 220 || /\b(why|explain|analy[sz]e|compare|plan|strategy|prove|derive|step by step|trade-?offs?)\b/i.test(text)) return "reasoning";
  if (/\b(latest|news|documentation|docs for)\b/i.test(text)) return "research";
  return "chat";
}

function renderTool(name: string, data: unknown): string {
  const d = data as Record<string, unknown> & { entries?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>> };
  switch (name) {
    case "system.resources": return `CPU ${d.cpuPercent}% across ${d.cores} cores. RAM ${d.ramUsedMb} of ${d.ramTotalMb} MB (${d.ramPercent}%). Server process ${d.serverRssMb} MB.`;
    case "system.info": return `${d.platform} ${d.release} (${d.arch}), ${d.cores} cores (${d.cpuModel}), ${d.totalMemoryMb} MB RAM, up ${d.uptimeHours} h, Node ${d.node}.`;
    case "time.now": return `It is ${d.local} (${d.timezone}).`;
    case "process.list": return (data as Array<Record<string, unknown>>).slice(0, 8).map((p) => `${p.name} (pid ${p.pid}, ${Math.round(Number(p.memoryKb) / 1024)} MB)`).join("\n");
    case "fs.list": return `${d.path}: ${d.count} item(s)\n` + (d.entries ?? []).slice(0, 30).map((e) => `${e.type === "dir" ? "[dir] " : ""}${e.name}${e.type === "file" ? ` (${e.sizeBytes} B)` : ""}`).join("\n");
    case "fs.read": return `${d.path}${d.truncated ? " (truncated)" : ""}:\n${truncate(String(d.content), 1500)}`;
    case "fs.search": return `Scanned ${d.scanned} entries, ${(d.results ?? []).length} match(es)\n` + (d.results ?? []).slice(0, 15).map((r) => `${r.path} [${r.match}]${r.snippet ? ` …${r.snippet}…` : ""}`).join("\n");
    case "fs.write": return `Wrote ${d.path} (${d.bytes} bytes).${d.backedUpAs ? ` Previous version backed up as ${d.backedUpAs}.` : ""}`;
    case "fs.delete": return `Deleted ${d.path}. It is recoverable: say "restore file ${d.trashId}".`;
    case "fs.mkdir": return `Created folder ${d.path}.`;
    case "fs.restore": return `Restored ${d.restoredTo}.`;
    case "app.open": return `Launched ${d.launched}.`;
    case "process.kill": return `Sent ${d.signal} to process ${d.pid}.`;
    case "script.run": return `Script finished (exit ${d.exitCode}${d.sandboxed ? ", permission-restricted" : ""}):\n${truncate(String(d.output), 1200)}`;
    case "android.notify": case "android.launch_app": case "android.device_info": return `Command ${d.status} for ${d.device}. ${d.note}`;
    default: return truncate(JSON.stringify(data), 900);
  }
}

function renderSkill(slug: string, out: unknown): string {
  const o = out as Record<string, unknown>;
  if (slug === "math.evaluate") return `${o.expression} = ${o.result}`;
  if (slug === "unit.convert") return `${o.value} ${o.from} = ${o.result} ${o.to}`;
  if (o && typeof o === "object" && !Array.isArray(o)) return Object.entries(o).slice(0, 10).map(([k, v]) => `${k}: ${typeof v === "object" ? truncate(JSON.stringify(v), 220) : v}`).join("\n");
  return JSON.stringify(out);
}

async function* callTool(name: string, args: Record<string, unknown>): AsyncGenerator<CoreEvent, ToolOutcome> {
  yield { t: "phase", phase: "executing" };
  yield { t: "tool", name, status: "running", risk: "-" };
  const out = await invokeTool(name, args, { actor: "user-chat" });
  yield { t: "tool", name, status: out.status, risk: out.risk, detail: out.error };
  if (out.status === "approval_required" && out.approval) yield { t: "approval", approval: { ...out.approval, tool: name } };
  return out;
}

const OFFLINE_HELP =
  "What works without a model: remember/recall, skills (try \"calculate 12*(3+4)\" or \"convert 5 km to mi\"), system and file tools, research, diagnostics, security audit and agent audits. To enable open conversation set GROQ_API_KEY or GEMINI_API_KEY, or install Ollama and run \"ollama pull llama3.2:3b\".";

async function* handle(i: Intent, text: string, ctx: { conversationId: string; voice: boolean; signal?: AbortSignal; meta: Record<string, unknown> }): AsyncGenerator<CoreEvent, string> {
  switch (i.kind) {
    case "remember": {
      const short = /\b(for now|today|temporar|this session|right now)\b/i.test(i.text);
      const o = yield* callTool("memory.add", { layer: short ? "short_term" : "long_term", content: i.text, source: "chat" });
      if (o.status === "ok") {
        const r = o.data as { created: boolean; note?: string };
        return r.created ? `Noted. I've stored that in ${short ? "short-term (24 h)" : "long-term"} memory.` : `I already have that: ${r.note}.`;
      }
      return o.status === "error" ? `I did not store it: ${o.error}` : o.error ?? "Not permitted.";
    }
    case "recall": {
      const o = yield* callTool("memory.search", { query: i.query, limit: 5 });
      if (o.status !== "ok") return o.error ?? "Memory search failed.";
      const hits = o.data as Array<{ title: string; content: string; layer: string; score: number }>;
      if (!hits.length) return `I have nothing stored about "${i.query}".`;
      return `I remember ${hits.length} relevant item(s):\n` + hits.map((h) => `• ${truncate(h.content.replace(/\s+/g, " "), 200)} (${h.layer.replace("_", "-")}, relevance ${h.score})`).join("\n");
    }
    case "forget": {
      const s = yield* callTool("memory.search", { query: i.query, limit: 1 });
      const hits = s.status === "ok" ? (s.data as Array<{ id: string; title: string }>) : [];
      if (!hits.length) return `I couldn't find a stored memory about "${i.query}".`;
      const o = yield* callTool("memory.delete", { id: hits[0].id, title: hits[0].title });
      if (o.status === "approval_required") return `Deleting "${hits[0].title}" is a high-risk action, so I need your approval first. Please approve or deny the request below.`;
      return o.status === "ok" ? "Deleted." : o.error ?? "Could not delete.";
    }
    case "tool": {
      const o = yield* callTool(i.name, i.args);
      if (o.status === "ok") return renderTool(i.name, o.data);
      if (o.status === "approval_required") return `${o.approval?.summary}. This is a ${o.risk} risk action, so I need your explicit approval${o.risk === "CRITICAL" ? " (you will be asked to type CONFIRM)" : ""}. Nothing has been executed.`;
      return o.error ?? "The tool failed.";
    }
    case "skill_trigger": {
      yield { t: "phase", phase: "executing" };
      yield { t: "tool", name: `skill:${i.slug}`, status: "running", risk: "LOW" };
      const r = await runSkill(i.slug, i.input, { actor: "core" });
      yield { t: "tool", name: `skill:${i.slug}`, status: r.ok ? "ok" : "error", risk: "LOW", detail: r.error };
      ctx.meta.skill = { slug: i.slug, version: r.version, status: r.status, ms: r.durationMs };
      if (r.ok) return `${renderSkill(i.slug, r.output)}\n(skill ${i.slug} v${r.version}, ${r.status}, ${r.durationMs} ms in sandbox)`;
      return `The ${i.name} skill could not handle that: ${r.error}`;
    }
    case "skill_list": {
      const all = await listSkills();
      const by = (s: string) => all.filter((x) => x.status === s).length;
      return `${all.length} skills: ${by("VERIFIED")} verified, ${by("TESTED")} tested, ${by("EXPERIMENTAL") + by("DEVELOPING")} experimental, ${by("FAILED")} failed, ${by("DISABLED")} disabled.\n` + all.slice(0, 14).map((s) => `• ${s.slug} - ${s.name} [${s.status}]`).join("\n") + (all.length > 14 ? `\n…and ${all.length - 14} more in the Skill Library.` : "");
    }
    case "acquire": {
      const id = await startAcquisition(i.request);
      yield { t: "data", kind: "acquisition", payload: { id } };
      const hasModel = await modelAvailable("coding");
      return `Skill acquisition started (${id.slice(0, 8)}): identify → research → decompose → develop → sandbox → validate → register.${hasModel ? "" : "\nNote: no language model is reachable, so the pipeline will stop at DEVELOP unless you submit an implementation manually in Skill Library › Acquisition."}\nSay "acquisition status" or open the Skill Library to follow progress. The skill is only usable if it passes validation.`;
    }
    case "acquire_status": {
      const [last] = await listAcquisitions();
      if (!last) return "No skill acquisitions have been started yet.";
      const full = await getAcquisition(last.id);
      const log = (full?.log ?? []).slice(-4).map((l) => `${l.phase}: ${l.message}`).join("\n");
      return `Latest acquisition "${truncate(last.request, 60)}" is ${last.status} (phase ${last.phase}).\n${log}`;
    }
    case "research": {
      const o = yield* callTool("research.topic", { topic: i.topic, store: false });
      if (o.status !== "ok") return o.error ?? "Research failed.";
      const r = o.data as { summary: string; sources: Array<{ n: number; title: string; url: string; reliability: string }>; warnings: string[]; operationalNote: string; comparison: { note: string } };
      yield { t: "data", kind: "research", payload: o.data };
      return `${r.summary}\n\nSources:\n${r.sources.map((s) => `[${s.n}] ${s.title} (${s.reliability}) ${s.url}`).join("\n")}\n\nCross-check: ${r.comparison.note}.${r.warnings.length ? `\nCaveats: ${r.warnings.slice(0, 3).join("; ")}` : ""}\n${r.operationalNote}`;
    }
    case "agents": {
      yield { t: "phase", phase: "executing" };
      yield { t: "tool", name: "agents.run", status: "running", risk: "MEDIUM" };
      const id = await startRun(i.goal);
      for (let n = 0; n < 40; n++) {
        await new Promise((r) => setTimeout(r, 1000));
        const d = await getRun(id);
        if (d && d.run.status !== "running") {
          const res = d.run.result as { verified?: boolean; lines?: string[]; issues?: string[] } | null;
          yield { t: "tool", name: "agents.run", status: "ok", risk: "MEDIUM" };
          yield { t: "data", kind: "agent_run", payload: { id } };
          return `Agent run ${d.run.status.toUpperCase()} (${d.run.template}).\n${(res?.lines ?? []).join("\n")}${res?.issues?.length ? `\nIssues:\n${res.issues.slice(0, 5).map((x) => `• ${x}`).join("\n")}` : ""}`;
        }
      }
      yield { t: "tool", name: "agents.run", status: "running", risk: "MEDIUM" };
      yield { t: "data", kind: "agent_run", payload: { id } };
      return `The agents are still working (run ${id.slice(0, 8)}). Follow the Agents tab for live progress.`;
    }
    case "diagnose": {
      yield { t: "phase", phase: "executing" };
      const d = await engineerDiagnose();
      return d.findings.map((f) => `${f.level === "ok" ? "✔" : f.level === "warn" ? "⚠" : "✘"} ${f.message}`).join("\n") + (d.topProcesses.length ? `\nTop processes: ${d.topProcesses.slice(0, 4).map((p) => p.name).join(", ")}` : "");
    }
    case "security_audit": {
      yield { t: "phase", phase: "executing" };
      const a = await securityAudit();
      return `Security score ${a.score}/100 - ${a.passed}/${a.total} checks passed.\n` + a.checks.map((c) => `${c.passed ? "✔" : "✘"} ${c.name}: ${c.detail}`).join("\n");
    }
    case "translate": {
      yield { t: "phase", phase: "thinking" };
      try {
        const r = await translateText(i.text, i.target);
        return r.translation;
      } catch (e) {
        return e instanceof NoModelError ? `Translation needs a language model, and none is reachable. ${OFFLINE_HELP}` : `Translation failed: ${errMsg(e)}`;
      }
    }
    case "evolve": {
      yield { t: "phase", phase: "executing" };
      const a = await analyze();
      const r = await evolutionReport();
      const x = r.indicators;
      return `Self-evaluation (last ${r.windowDays} days): ${x.tasks.total} tasks (${x.tasks.successRatePct ?? "n/a"}% ok), ${x.skills.runs} skill runs (${x.skills.successRatePct ?? "n/a"}% ok), ${x.tools.total} tool calls, ${x.capabilityGaps} unhandled requests.\n${a.created} new suggestion(s); ${a.total} awaiting your decision in System Monitor › Evolution. Nothing is applied without your approval.`;
    }
    case "capabilities": {
      const [skillsAll, mem, model] = await Promise.all([listSkills(), memoryStats(), modelAvailable("chat")]);
      return `Language model: ${model ? "available" : "NOT available (set GROQ_API_KEY / GEMINI_API_KEY or run Ollama)"}. Skills: ${skillsAll.filter((s) => USABLE.includes(s.status)).length} usable of ${skillsAll.length}. Memories: ${mem.total}.\nTry: "remember that ...", "recall ...", "calculate 2^10", "convert 5 km to mi", "research <topic>", "learn how to <capability>", "audit skill math.evaluate", "diagnose system", "security audit", "list files", "self-evaluate", "list skills", "translate to Tamil: hello".`;
    }
    case "chat": return yield* chatWithModel(text, ctx);
  }
}

async function* chatWithModel(text: string, ctx: { conversationId: string; voice: boolean; signal?: AbortSignal; meta: Record<string, unknown> }): AsyncGenerator<CoreEvent, string> {
  yield { t: "phase", phase: "thinking" };
  const task = pickTask(text);
  if (!(await modelAvailable(task))) {
    const why = (await modelDiagnosis(task)).join("; ");
    void recordMetric("intent.unhandled", 1, { text: truncate(redactSecrets(text), 160) });
    return `I can't hold an open conversation right now - no language model is reachable (${why}).\n${OFFLINE_HELP}`;
  }
  // Reuse an acquired skill semantically (model extracts inputs; schema + sandbox still enforce correctness).
  const cand = (await findSkills(text, 1))[0];
  if (cand && cand.score >= 0.5) {
    try {
      const r = await complete("agent", { json: true, temperature: 0, maxTokens: 300, messages: [{ role: "system", content: `Decide if the user's request should be answered by this skill. Skill: ${cand.skill.slug} - ${cand.skill.description}. Input schema: ${JSON.stringify(cand.skill.inputSchema)}. Reply JSON only: {"use":boolean,"input":object}. Use it only if the request clearly supplies every required input value.` }, { role: "user", content: text }] });
      const j = extractJson<{ use?: boolean; input?: unknown }>(r.text);
      if (j?.use && validateSchema(cand.skill.inputSchema as Schema, j.input).length === 0) {
        yield { t: "phase", phase: "executing" };
        yield { t: "tool", name: `skill:${cand.skill.slug}`, status: "running", risk: "LOW" };
        const run = await runSkill(cand.skill.slug, j.input, { actor: "core" });
        yield { t: "tool", name: `skill:${cand.skill.slug}`, status: run.ok ? "ok" : "error", risk: "LOW", detail: run.error };
        if (run.ok) {
          ctx.meta.skill = { slug: cand.skill.slug, version: run.version, status: run.status };
          return `${renderSkill(cand.skill.slug, run.output)}\n(skill ${cand.skill.slug} v${run.version}, ${run.status})`;
        }
      }
    } catch { /* fall through to normal chat */ }
  }
  const mem = await relevantContext(text, 4);
  const lang = detectLanguage(text, "en-GB");
  const sc = scholarClassify(text);
  const system = [
    "You are JARVIS, the conversational and voice interface of BRAHMA, a personal intelligence system. Tone: professional, calm, precise, with understated dry wit (British butler style). Never imitate any copyrighted character's exact voice or lines.",
    "Honesty: claim only abilities that really exist. Real abilities: persistent memory, sandboxed skills, web research with source ratings, agent delegation, system diagnostics, workspace file tools (permission-gated), skill acquisition (say 'learn how to ...'). If asked to do something else, say so plainly and suggest acquiring a skill. Never say you did something you did not do.",
    ctx.voice ? "You are speaking aloud: answer in one to four short sentences, plain prose, no markdown, no lists, no URLs." : "Be concise. Markdown is allowed.",
    lang !== "en-GB" ? `The user writes in ${lang}; answer in that language.` : "Answer in the language of the user's latest message.",
    sc.discipline ? `Subject area: ${sc.discipline}. Be rigorous and flag uncertainty.` : "",
    "Do not reveal private chain-of-thought; give conclusions, key evidence and caveats.",
    UNTRUSTED_NOTICE,
    mem.length ? `Relevant stored memories (user-controlled, may be outdated):\n${mem.map((m) => `- ${truncate(m.content.replace(/\s+/g, " "), 240)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  const history = await db.select().from(messages).where(eq(messages.conversationId, ctx.conversationId)).orderBy(desc(messages.createdAt)).limit(11);
  const convo: ChatMessage[] = history.reverse().slice(0, -1).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content.slice(0, 1500) }));
  let out = "";
  try {
    for await (const ev of streamChat(task, { messages: [{ role: "system", content: system }, ...convo, { role: "user", content: text }], temperature: 0.6, maxTokens: ctx.voice ? 300 : 900 }, { signal: ctx.signal })) {
      if (ev.type === "delta") { out += ev.text; yield { t: "delta", text: ev.text }; }
      else { ctx.meta.model = `${ev.result.provider}/${ev.result.model}`; ctx.meta.tokens = ev.result.usage.prompt + ev.result.usage.completion; ctx.meta.task = task; if (ev.result.failedOver.length) ctx.meta.failedOver = ev.result.failedOver; }
    }
  } catch (e) {
    if (e instanceof NoModelError) {
      void recordMetric("intent.unhandled", 1, { text: truncate(redactSecrets(text), 160) });
      return `The language models failed to respond (${truncate(e.message, 240)}).\n${OFFLINE_HELP}`;
    }
    throw e;
  }
  return out.trim() || "I have no response to that.";
}

export async function* handleMessage(inp: { text: string; conversationId?: string; voice?: boolean; signal?: AbortSignal }): AsyncGenerator<CoreEvent> {
  const started = Date.now();
  const text = inp.text.trim().slice(0, 4000);
  let conversationId = inp.conversationId;
  if (conversationId) {
    const [c] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!c) conversationId = undefined;
  }
  if (!conversationId) {
    const [c] = await db.insert(conversations).values({ title: truncate(redactSecrets(text), 48) || "New conversation" }).returning({ id: conversations.id });
    conversationId = c.id;
  }
  const secrets = detectSecrets(text);
  await db.insert(messages).values({ conversationId, role: "user", content: secrets.length ? redactSecrets(text) : text, meta: { voice: !!inp.voice, redacted: secrets.length > 0 } });
  yield { t: "phase", phase: "understanding" };
  const intent = await classify(text);
  const engine = engineFor(intent, text);
  yield { t: "intent", intent: intent.kind, engine };
  const meta: Record<string, unknown> = { intent: intent.kind, engine, conversationId };
  let reply = "";
  let ok = true;
  try {
    reply = yield* handle(intent, text, { conversationId, voice: !!inp.voice, signal: inp.signal, meta });
  } catch (e) {
    ok = false;
    reply = `That did not work: ${errMsg(e)}`;
  }
  if (secrets.length) reply += `\n(I noticed what looks like a secret in your message - ${secrets.join(", ")} - and redacted it from my conversation history.)`;
  meta.latencyMs = Date.now() - started;
  await db.insert(messages).values({ conversationId, role: "assistant", content: reply, meta });
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  void recordMetric("chat.turn", ok ? 1 : 0, { intent: intent.kind, engine, ms: meta.latencyMs as number });
  void markEngine(engine, intent.kind);
  yield { t: "done", text: reply, meta };
}
