import { body, json, route, str } from "@/lib/api";
import { clearProviderCooldown, getModelConfig, modelDiagnosis, providerStatuses, saveModelConfig } from "@/lib/models/router";
import { PROVIDER_IDS, TASK_KINDS, type ProviderId } from "@/lib/models/providers";
import { networkStatus } from "@/lib/net";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const [providers, config, net, diagnosis] = await Promise.all([providerStatuses(force), getModelConfig(), networkStatus(force), modelDiagnosis("chat")]);
  return json({ providers, config, network: net, diagnosis, tasks: TASK_KINDS });
});

export const POST = route(async (req: Request) => {
  const b = await body(req);
  const action = str(b.action);
  if (action === "save") {
    await saveModelConfig(b.config as never);
    return json({ ok: true });
  }
  if (action === "clear_cooldown") {
    clearProviderCooldown(PROVIDER_IDS.includes(b.provider as ProviderId) ? (b.provider as ProviderId) : undefined);
    return json({ ok: true });
  }
  if (action === "test") {
    const providers = await providerStatuses(true);
    return json({ providers });
  }
  return json({ error: "unknown action" }, 400);
});
