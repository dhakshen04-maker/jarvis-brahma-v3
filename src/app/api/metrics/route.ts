import { body, json, route, str } from "@/lib/api";
import { recordMetric } from "@/lib/log";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["voice.latency_ms", "voice.confidence", "voice.wake", "voice.barge_in", "voice.error", "voice.recognition_restart"]);

/** Client-measured voice metrics (latency, recognition confidence, events). Whitelisted names only. */
export const POST = route(async (req: Request) => {
  const b = await body<{ events?: Array<{ name?: string; value?: number; labels?: Record<string, unknown> }> }>(req);
  let n = 0;
  for (const e of (b.events ?? []).slice(0, 20)) {
    const name = str(e.name);
    if (!ALLOWED.has(name) || typeof e.value !== "number" || !Number.isFinite(e.value)) continue;
    await recordMetric(name, Math.max(-1, Math.min(1e6, e.value)), { lang: str(e.labels?.lang), mode: str(e.labels?.mode) });
    n++;
  }
  return json({ recorded: n });
});
