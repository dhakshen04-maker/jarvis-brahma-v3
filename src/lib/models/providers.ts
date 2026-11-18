/**
 * Model provider adapters. Credentials are read from environment variables only:
 *   GROQ_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY), OLLAMA_BASE_URL,
 *   CUSTOM_LLM_BASE_URL / CUSTOM_LLM_API_KEY / CUSTOM_LLM_MODEL (any OpenAI-compatible server).
 */
export type TaskKind = "chat" | "reasoning" | "coding" | "research" | "summarization" | "translation" | "agent";
export const TASK_KINDS: TaskKind[] = ["chat", "reasoning", "coding", "research", "summarization", "translation", "agent"];
export type ProviderId = "groq" | "gemini" | "ollama" | "custom";
export const PROVIDER_IDS: ProviderId[] = ["groq", "gemini", "ollama", "custom"];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface GenOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}
export interface Usage {
  prompt: number;
  completion: number;
  estimated: boolean;
}
export type Chunk = { delta?: string; usage?: Usage };

export type ProviderErrorKind = "rate_limit" | "auth" | "transient" | "bad_request";
export class ProviderError extends Error {
  kind: ProviderErrorKind;
  retryAfterMs?: number;
  constructor(message: string, kind: ProviderErrorKind, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ProviderCfg {
  enabled: boolean;
  baseUrl?: string;
  models: Partial<Record<TaskKind, string>>;
  /** 0 = unlimited. Free tiers are not unlimited - set a budget to stay safe. */
  dailyTokenLimit: number;
}

export interface ProviderDef {
  id: ProviderId;
  label: string;
  local: boolean;
  keyEnv: string;
  defaultBaseUrl: string;
  defaultModels: Record<TaskKind, string>;
  apiKey(): string | undefined;
  /** Credentials/endpoint present (does not imply reachable). */
  configured(): boolean;
  health(baseUrl: string, signal: AbortSignal): Promise<{ ok: boolean; models: string[]; error?: string }>;
  stream(a: { baseUrl: string; model: string; opts: GenOptions; signal: AbortSignal }): AsyncGenerator<Chunk>;
}

const env = (...names: string[]) => names.map((n) => process.env[n]).find((v) => v && v.trim().length > 0)?.trim();
const allTasks = (m: string): Record<TaskKind, string> => ({ chat: m, reasoning: m, coding: m, research: m, summarization: m, translation: m, agent: m });

async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const rest = buf.trim();
  if (rest.startsWith("data:")) yield rest.slice(5).trim();
}

async function errorFrom(res: Response): Promise<ProviderError> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  const retry = Number(res.headers.get("retry-after"));
  const retryMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined;
  if (res.status === 429) return new ProviderError(`rate limited (429) ${body}`, "rate_limit", retryMs ?? 60_000);
  if (res.status === 401 || res.status === 403) return new ProviderError(`authentication failed (${res.status})`, "auth");
  if (res.status >= 500) return new ProviderError(`provider error ${res.status}`, "transient");
  return new ProviderError(`request rejected (${res.status}) ${body}`, "bad_request");
}

function networkError(e: unknown): ProviderError {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ProviderError) return e;
  if (e instanceof Error && e.name === "AbortError") return new ProviderError("timed out or cancelled", "transient");
  return new ProviderError(`network error: ${msg}`, "transient");
}

async function* openAiCompatStream(base: string, key: string | undefined, model: string, opts: GenOptions, signal: AbortSignal): AsyncGenerator<Chunk> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: opts.temperature ?? 0.6,
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await errorFrom(res);
  try {
    for await (const data of sseData(res)) {
      if (data === "[DONE]") break;
      let j: { choices?: Array<{ delta?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) yield { delta };
      if (j.usage) yield { usage: { prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens ?? 0, estimated: false } };
    }
  } catch (e) {
    throw networkError(e);
  }
}

async function listModels(url: string, headers: Record<string, string>, signal: AbortSignal, pick: (j: unknown) => string[]) {
  try {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) return { ok: false, models: [], error: (await errorFrom(res)).message };
    return { ok: true, models: pick(await res.json()) };
  } catch (e) {
    return { ok: false, models: [] as string[], error: networkError(e).message };
  }
}

const idsOf = (j: unknown) => ((j as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id);

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  groq: {
    id: "groq", label: "Groq", local: false, keyEnv: "GROQ_API_KEY",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModels: { ...allTasks("llama-3.3-70b-versatile"), summarization: "llama-3.1-8b-instant" },
    apiKey: () => env("GROQ_API_KEY"),
    configured: () => !!env("GROQ_API_KEY"),
    health: (base, signal) => listModels(`${base}/models`, { authorization: `Bearer ${env("GROQ_API_KEY") ?? ""}` }, signal, idsOf),
    stream: ({ baseUrl, model, opts, signal }) => openAiCompatStream(baseUrl, env("GROQ_API_KEY"), model, opts, signal),
  },
  gemini: {
    id: "gemini", label: "Google Gemini", local: false, keyEnv: "GEMINI_API_KEY",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModels: allTasks("gemini-2.5-flash"),
    apiKey: () => env("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    configured: () => !!env("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    health: (base, signal) =>
      listModels(`${base}/models?pageSize=100`, { "x-goog-api-key": env("GEMINI_API_KEY", "GOOGLE_API_KEY") ?? "" }, signal, (j) =>
        ((j as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name.replace(/^models\//, "")),
      ),
    async *stream({ baseUrl, model, opts, signal }) {
      const system = opts.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const contents = opts.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "Hello" }] });
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", "x-goog-api-key": env("GEMINI_API_KEY", "GOOGLE_API_KEY") ?? "" },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents,
            generationConfig: {
              temperature: opts.temperature ?? 0.6,
              maxOutputTokens: opts.maxTokens ?? 1024,
              ...(opts.json ? { responseMimeType: "application/json" } : {}),
            },
          }),
        });
      } catch (e) {
        throw networkError(e);
      }
      if (!res.ok) throw await errorFrom(res);
      try {
        for await (const data of sseData(res)) {
          let j: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
          if (text) yield { delta: text };
          if (j.usageMetadata) yield { usage: { prompt: j.usageMetadata.promptTokenCount ?? 0, completion: j.usageMetadata.candidatesTokenCount ?? 0, estimated: false } };
        }
      } catch (e) {
        throw networkError(e);
      }
    },
  },
  ollama: {
    id: "ollama", label: "Ollama (local)", local: true, keyEnv: "OLLAMA_BASE_URL",
    defaultBaseUrl: env("OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434",
    defaultModels: { ...allTasks("llama3.2:3b"), coding: "qwen2.5-coder:1.5b" },
    apiKey: () => undefined,
    configured: () => true,
    health: (base, signal) =>
      listModels(`${base.replace(/\/$/, "")}/api/tags`, {}, signal, (j) => ((j as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name)),
    stream: ({ baseUrl, model, opts, signal }) => openAiCompatStream(`${baseUrl.replace(/\/$/, "")}/v1`, undefined, model, opts, signal),
  },
  custom: {
    id: "custom", label: "OpenAI-compatible", local: false, keyEnv: "CUSTOM_LLM_BASE_URL",
    defaultBaseUrl: env("CUSTOM_LLM_BASE_URL") ?? "",
    defaultModels: allTasks(env("CUSTOM_LLM_MODEL") ?? "gpt-4o-mini"),
    apiKey: () => env("CUSTOM_LLM_API_KEY"),
    configured: () => !!env("CUSTOM_LLM_BASE_URL"),
    health: (base, signal) => listModels(`${base.replace(/\/$/, "")}/models`, env("CUSTOM_LLM_API_KEY") ? { authorization: `Bearer ${env("CUSTOM_LLM_API_KEY")}` } : {}, signal, idsOf),
    stream: ({ baseUrl, model, opts, signal }) => openAiCompatStream(baseUrl, env("CUSTOM_LLM_API_KEY"), model, opts, signal),
  },
};
