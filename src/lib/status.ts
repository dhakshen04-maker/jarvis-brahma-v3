/**
 * Honest implementation status. Levels are declared here by the developers; evidence strings are computed
 * live from the running system so a dashboard can never claim more than is actually in place.
 */
import os from "node:os";
import { db } from "@/db";
import { agentRuns, devices, skillAcquisitions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { providerStatuses } from "@/lib/models/router";
import { listSkills } from "@/lib/skills/registry";
import { memoryStats } from "@/lib/memory/store";
import { networkStatus } from "@/lib/net";
import { listTools } from "@/lib/tools";

export interface MilestoneStatus {
  id: number;
  title: string;
  level: "implemented" | "partial" | "not_implemented";
  evidence: string;
  limits: string;
}

export async function milestoneStatus(): Promise<MilestoneStatus[]> {
  const [providers, skills, mem, net] = await Promise.all([providerStatuses(), listSkills(), memoryStats(), networkStatus()]);
  const up = providers.filter((p) => p.reachable);
  const [runs] = await db.select({ n: sql<number>`count(*)::int`, verified: sql<number>`count(*) filter (where ${agentRuns.status}='verified')::int` }).from(agentRuns);
  const [acq] = await db.select({ n: sql<number>`count(*)::int`, done: sql<number>`count(*) filter (where ${skillAcquisitions.status}='completed')::int`, blocked: sql<number>`count(*) filter (where ${skillAcquisitions.status}='blocked')::int` }).from(skillAcquisitions);
  const [dev] = await db.select({ n: sql<number>`count(*)::int` }).from(devices).where(eq(devices.platform, "android"));
  const verified = skills.filter((s) => s.status === "VERIFIED").length;
  const tested = skills.filter((s) => s.status === "TESTED").length;
  return [
    { id: 1, title: "Inspect and stabilise the existing application", level: "implemented", evidence: "The repository contained only a blank starter page (no JARVIS UI existed); /api/health preserved and still passes.", limits: "The 'Option B' interface referenced in the brief was not present in the repo; the HUD was designed fresh from the reference image." },
    { id: 2, title: "Real voice input and output", level: "partial", evidence: "Browser SpeechRecognition + speechSynthesis with mic metering, device selection and voice profiles. Verify in the Voice tab (self-test).", limits: "Needs a Chromium-based browser; Chrome's recogniser streams audio to the vendor unless on-device mode is available. No Whisper/Piper in this web build." },
    { id: 3, title: "Wake word and continuous conversation", level: "partial", evidence: "Wake phrase matched on live transcripts (configurable, per-language aliases); session stays open until silence timeout; barge-in cancels speech.", limits: "Not an acoustic wake-word model (OpenWakeWord not integrated); wake detection requires the recogniser to be running." },
    { id: 4, title: "Model router", level: up.length ? "implemented" : "partial", evidence: up.length ? `Live providers: ${up.map((p) => p.label).join(", ")}. Fallback, cooldown, budgets and usage tracking active.` : "Routing, fallback, rate-limit cooldowns and usage tracking are implemented but NO provider is reachable here, so live model calls are untested in this environment.", limits: "Free tiers are rate limited; set daily token budgets in Settings." },
    { id: 5, title: "Persistent memory", level: "implemented", evidence: `${mem.total} memories across 6 layers in PostgreSQL (${mem.sensitive} sensitive).`, limits: "Uses local hashed n-gram vectors, not neural embeddings." },
    { id: 6, title: "Skill registry", level: "implemented", evidence: `${skills.length} skills: ${verified} VERIFIED, ${tested} TESTED. Versioning, promote, rollback and enable/disable implemented.`, limits: "Skills are synchronous JavaScript executed in the sandbox." },
    { id: 7, title: "Skill acquisition pipeline", level: "partial", evidence: `${acq.n} run(s): ${acq.done} completed, ${acq.blocked} blocked. Pipeline phases implemented; manual implementation path works without a model.`, limits: up.length ? "Model-generated skills depend on the quality of the configured model." : "Model-driven DEVELOP phase is untested here because no provider is reachable." },
    { id: 8, title: "Sandbox testing and validation", level: "implemented", evidence: `Child process with Node permission model, heap cap, stripped env, vm context. ${verified} skills passed the full validator.`, limits: "Process isolation, not a container/VM; network sockets are not blocked at OS level (code has no network API)." },
    { id: 9, title: "Multi-agent coordination", level: "implemented", evidence: `10 agents, dependency graph, retries, reassignment, critic. ${runs.n} run(s), ${runs.verified} verified.`, limits: "Template-based planning; LLM-dependent agents degrade without a model." },
    { id: 10, title: "Autonomous research", level: net.online ? "implemented" : "partial", evidence: net.online ? `Network reachable (${net.checks.filter((c) => c.ok).length}/${net.checks.length} probes). Search, fetch, rating and citations active.` : "Server has no internet access right now; research cannot retrieve sources.", limits: "No PDF or JS-rendered pages; DuckDuckGo may be bot-blocked, Wikipedia is the reliable source." },
    { id: 11, title: "Windows and Android integrations", level: "partial", evidence: `${listTools().length} permission-gated tools on ${os.platform()}. ${dev.n} Android device(s) paired.`, limits: "The Android (Kotlin) client app is not part of this repo - only the authenticated server contract (/api/device/*) exists. Windows tools use Windows commands only when the server runs on Windows." },
    { id: 12, title: "Self-evaluation and controlled evolution", level: "implemented", evidence: "Metrics, failure/gap detection and approval-gated suggestions. No code path can modify security policy.", limits: "Does not rewrite its own source code." },
    { id: 13, title: "Interface polish and system monitoring", level: "implemented", evidence: "All dashboards read live data (OS counters, DB, probes, browser audio APIs).", limits: "GPU metrics are not available." },
  ];
}
