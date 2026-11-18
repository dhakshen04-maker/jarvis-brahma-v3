/**
 * Adaptive model router: picks provider + model per task kind, checks availability, enforces
 * timeouts, handles rate limits with cooldowns, falls back across providers, tracks token usage
 * and respects local-only mode (offline).
 */
import { db } from "@/db";
import { modelUsage } from "@/db/schema";
import { gte, sql } from "drizzle-orm";
import { getSetting, setSetting } from "@/lib/settings";
import { cachedNetwork } from "@/lib/net";
import { logEvent } from "@/lib/log";
import {
  PROVIDERS, PROVIDER_IDS, TASK_KINDS, ProviderError,
  type ChatMessage, type GenOptions, type ProviderCfg, type ProviderId, type TaskKind, type Usage,
} from "@/lib/models/providers";

export type RouteMode = "auto" | "local-only" | "cloud-only";

export interface ModelConfig {
  mode: RouteMode;
  timeoutMs: number;
  order: Record<TaskKind, ProviderId[]>;
  providers: Record<ProviderId, ProviderCfg>;
}

const DEFAULT_ORDER: Record<TaskKind, ProviderId[]> = {
  chat: ["groq", "gemini", "custom", "ollama"],
  reasoning: ["gemini", "groq", "custom", "ollama"],
  coding: ["groq", "gemini", "custom", "ollama"],
  research: ["gemini", "groq", "custom", "ollama"],
  summarization: ["groq", "gemini", "custom", "ollama"],
  translation: ["gemini", "groq", "custom", "ollama"],
  agent: ["groq", "gemini", "custom", "ollama"],
};

type SavedConfig = Partial<Omit<ModelConfig, "providers">> & { providers?: Partial<Record<ProviderId, Partial<ProviderCfg>>> };

export async function getModelConfig(): Promise<ModelConfig> {
  const saved = await getSetting<SavedConfig>("models.config", {});
  const providers = {} as Record<ProviderId, ProviderCfg>;
  for (const id of PROVIDER_IDS) {
    const s = saved.providers?.[id] ?? {};
    providers[id] = {
      enabled: s.enabled ?? true,
      baseUrl: s.baseUrl || undefined,
      models: { ...PROVIDERS[id].defaultModels, ...(s.models ?? {}) },
      dailyTokenLimit: s.dailyTokenLimit ?? 0,
    };
  }
  return {
    mode: saved.mode ?? "auto",
    timeoutMs: saved.timeoutMs ?? 25_000,
    order: { ...DEFAULT_ORDER, ...(saved.order ?? {}) },
    providers,
  };
}

export async function saveModelConfig(patch: SavedConfig) {
  const saved = await getSetting<SavedConfig>("models.config", {});
  const next: SavedConfig = {
    ...saved,
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.timeoutMs ? { timeoutMs: Math.min(Math.max(patch.timeoutMs, 3000), 120_000) } : {}),
    ...(patch.order ? { order: { ...saved.order, ...patch.order } } : {}),
    providers: { ...saved.providers },
  };
  for (const id of PROVIDER_IDS) {
    const p = patch.providers?.[id];
    if (p) next.providers![id] = { ...saved.providers?.[id], ...p, models: { ...saved.providers?.[id]?.models, ...p.models } };
  }
  await setSetting("models.config", next);
  healthCache.clear();
}

// ---------- runtime state ----------
const cooldowns = new Map<ProviderId, { until: number; reason: string }>();
const healthCache = new Map<string, { at: number; ok: boolean; models: string[]; error?: string }>();
let usageCache: { at: number; byProvider: Record<string, { prompt: number; completion: number; requests: number; errors: number }> } | null = null;

async function getHealth(id: ProviderId, baseUrl: string, force = false) {
  const key = `${id}:${baseUrl}`;
  const hit = healthCache.get(key);
  if (!force && hit && Date.now() - hit.at < 30_000) return hit;
  const r = await PROVIDERS[id].health(baseUrl, AbortSignal.timeout(4000));
  const entry = { at: Date.now(), ...r };
  healthCache.set(key, entry);
  return entry;
}

export async function usage24h() {
  if (usageCache && Date.now() - usageCache.at < 15_000) return usageCache.byProvider;
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await db
    .select({
      provider: modelUsage.provider,
      prompt: sql<number>`coalesce(sum(${modelUsage.promptTokens}),0)::int`,
      completion: sql<number>`coalesce(sum(${modelUsage.completionTokens}),0)::int`,
      requests: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${modelUsage.status} <> 'ok')::int`,
    })
    .from(modelUsage)
    .where(gte(modelUsage.ts, since))
    .groupBy(modelUsage.provider);
  const byProvider: Record<string, { prompt: number; completion: number; requests: number; errors: number }> = {};
  for (const r of rows) byProvider[r.provider] = { prompt: r.prompt, completion: r.completion, requests: r.requests, errors: r.errors };
  usageCache = { at: Date.now(), byProvider };
  return byProvider;
}

function resolveModel(id: ProviderId, cfg: ProviderCfg, task: TaskKind, installed: string[]): string {
  const wanted = cfg.models[task] ?? PROVIDERS[id].defaultModels[task];
  if (id !== "ollama" || installed.length === 0 || installed.includes(wanted)) return wanted;
  const family = wanted.split(":")[0];
  return installed.find((n) => n.startsWith(family)) ?? installed[0];
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  local: boolean;
  keyEnv: string;
  configured: boolean;
  enabled: boolean;
  reachable: boolean | null;
  error?: string;
  installedModels: string[];
  resolved: Record<TaskKind, string>;
  baseUrl: string;
  cooldown?: { until: number; reason: string };
  usage24h: { prompt: number; completion: number; requests: number; errors: number };
  dailyTokenLimit: number;
}

export async function providerStatuses(force = false): Promise<ProviderStatus[]> {
  const cfg = await getModelConfig();
  const usage = await usage24h();
  return Promise.all(
    PROVIDER_IDS.map(async (id): Promise<ProviderStatus> => {
      const def = PROVIDERS[id];
      const pc = cfg.providers[id];
      const baseUrl = pc.baseUrl || def.defaultBaseUrl;
      const configured = def.configured();
      let reachable: boolean | null = null;
      let error: string | undefined;
      let installed: string[] = [];
      if (pc.enabled && configured && baseUrl) {
        const h = await getHealth(id, baseUrl, force);
        reachable = h.ok;
        error = h.error;
        installed = h.models;
      }
      const resolved = {} as Record<TaskKind, string>;
      for (const t of TASK_KINDS) resolved[t] = resolveModel(id, pc, t, installed);
      const cd = cooldowns.get(id);
      return {
        id, label: def.label, local: def.local, keyEnv: def.keyEnv, configured, enabled: pc.enabled, reachable, error,
        installedModels: installed.slice(0, 40), resolved, baseUrl: id === "custom" || id === "ollama" ? baseUrl : def.defaultBaseUrl,
        cooldown: cd && cd.until > Date.now() ? cd : undefined,
        usage24h: usage[id] ?? { prompt: 0, completion: 0, requests: 0, errors: 0 },
        dailyTokenLimit: pc.dailyTokenLimit,
      };
    }),
  );
}

interface Candidate {
  id: ProviderId;
  model: string;
  baseUrl: string;
}

async function candidates(task: TaskKind): Promise<{ list: Candidate[]; skipped: string[] }> {
  const cfg = await getModelConfig();
  const net = cachedNetwork();
  const usage = await usage24h();
  const order = [...cfg.order[task], ...PROVIDER_IDS.filter((p) => !cfg.order[task].includes(p))];
  const list: Candidate[] = [];
  const skipped: string[] = [];
  for (const id of order) {
    const def = PROVIDERS[id];
    const pc = cfg.providers[id];
    const baseUrl = pc.baseUrl || def.defaultBaseUrl;
    if (!pc.enabled) { skipped.push(`${id}: disabled`); continue; }
    if (!def.configured() || !baseUrl) { skipped.push(`${id}: not configured (${def.keyEnv})`); continue; }
    if (cfg.mode === "local-only" && !def.local) { skipped.push(`${id}: local-only mode`); continue; }
    if (cfg.mode === "cloud-only" && def.local) { skipped.push(`${id}: cloud-only mode`); continue; }
    if (!def.local && net && !net.online) { skipped.push(`${id}: network offline`); continue; }
    const cd = cooldowns.get(id);
    if (cd && cd.until > Date.now()) { skipped.push(`${id}: cooling down (${cd.reason})`); continue; }
    const used = (usage[id]?.prompt ?? 0) + (usage[id]?.completion ?? 0);
    if (pc.dailyTokenLimit > 0 && used >= pc.dailyTokenLimit) { skipped.push(`${id}: daily token budget reached`); continue; }
    let installed: string[] = [];
    if (def.local) {
      const h = await getHealth(id, baseUrl);
      if (!h.ok) { skipped.push(`${id}: not reachable at ${baseUrl}`); continue; }
      if (h.models.length === 0) { skipped.push(`${id}: no models installed (run: ollama pull llama3.2:3b)`); continue; }
      installed = h.models;
    }
    list.push({ id, baseUrl, model: resolveModel(id, pc, task, installed) });
  }
  return { list, skipped };
}

export class NoModelError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(`No language model available. ${reasons.join("; ")}`);
    this.reasons = reasons;
  }
}

export async function modelAvailable(task: TaskKind = "chat"): Promise<boolean> {
  try {
    return (await candidates(task)).list.length > 0;
  } catch {
    return false;
  }
}

export async function modelDiagnosis(task: TaskKind = "chat"): Promise<string[]> {
  return (await candidates(task)).skipped;
}

export interface CompleteResult {
  text: string;
  provider: ProviderId;
  model: string;
  task: TaskKind;
  usage: Usage;
  latencyMs: number;
  partial?: boolean;
  failedOver: string[];
}
export type RouterEvent = { type: "delta"; text: string } | { type: "done"; result: CompleteResult };

const approxTokens = (s: string) => Math.ceil(s.length / 4);

async function recordUsage(p: { provider: string; model: string; task: TaskKind; usage?: Usage; latencyMs: number; status: string; error?: string }) {
  usageCache = null;
  try {
    await db.insert(modelUsage).values({
      provider: p.provider, model: p.model, task: p.task,
      promptTokens: p.usage?.prompt ?? 0, completionTokens: p.usage?.completion ?? 0, estimated: p.usage?.estimated ?? false,
      latencyMs: p.latencyMs, status: p.status, error: p.error?.slice(0, 300),
    });
  } catch {
    /* ignore */
  }
}

export async function* streamChat(task: TaskKind, opts: GenOptions, extra: { timeoutMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<RouterEvent> {
  const cfg = await getModelConfig();
  const timeoutMs = extra.timeoutMs ?? cfg.timeoutMs;
  const { list, skipped } = await candidates(task);
  const failedOver: string[] = [];
  if (list.length === 0) throw new NoModelError(skipped);

  for (const cand of list) {
    if (extra.signal?.aborted) return;
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    extra.signal?.addEventListener("abort", onAbort);
    const started = Date.now();
    let text = "";
    let usage: Usage | undefined;
    try {
      for await (const chunk of PROVIDERS[cand.id].stream({ baseUrl: cand.baseUrl, model: cand.model, opts, signal: controller.signal })) {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), timeoutMs);
        if (chunk.delta) {
          text += chunk.delta;
          yield { type: "delta", text: chunk.delta };
        }
        if (chunk.usage) usage = chunk.usage;
      }
      clearTimeout(timer);
      extra.signal?.removeEventListener("abort", onAbort);
      const finalUsage = usage ?? { prompt: approxTokens(opts.messages.map((m: ChatMessage) => m.content).join("\n")), completion: approxTokens(text), estimated: true };
      const latencyMs = Date.now() - started;
      await recordUsage({ provider: cand.id, model: cand.model, task, usage: finalUsage, latencyMs, status: "ok" });
      yield { type: "done", result: { text, provider: cand.id, model: cand.model, task, usage: finalUsage, latencyMs, failedOver } };
      return;
    } catch (e) {
      clearTimeout(timer);
      extra.signal?.removeEventListener("abort", onAbort);
      if (extra.signal?.aborted) return;
      const err = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e), "transient");
      const latencyMs = Date.now() - started;
      await recordUsage({ provider: cand.id, model: cand.model, task, latencyMs, status: err.kind === "rate_limit" ? "rate_limited" : "error", error: err.message });
      const cool = err.kind === "rate_limit" ? err.retryAfterMs ?? 60_000 : err.kind === "auth" ? 600_000 : err.kind === "transient" ? 30_000 : 0;
      if (cool > 0) cooldowns.set(cand.id, { until: Date.now() + cool, reason: err.kind });
      failedOver.push(`${cand.id}/${cand.model}: ${err.message}`);
      void logEvent("warn", "model-router", `${cand.id} failed (${err.kind}); ${list.length > 1 ? "trying fallback" : "no fallback"}`, { error: err.message });
      if (text.length > 0) {
        yield { type: "done", result: { text, provider: cand.id, model: cand.model, task, usage: { prompt: 0, completion: approxTokens(text), estimated: true }, latencyMs, partial: true, failedOver } };
        return;
      }
    }
  }
  throw new NoModelError(failedOver);
}

export async function complete(task: TaskKind, opts: GenOptions, extra: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CompleteResult> {
  let result: CompleteResult | null = null;
  for await (const ev of streamChat(task, opts, extra)) if (ev.type === "done") result = ev.result;
  if (!result) throw new Error("model call was cancelled");
  return result;
}

export function clearProviderCooldown(id?: ProviderId) {
  if (id) cooldowns.delete(id);
  else cooldowns.clear();
  healthCache.clear();
}
