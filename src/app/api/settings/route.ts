import { body, json, route } from "@/lib/api";
import { DEFAULT_PREFS, getPrefs, setSetting, type CorePrefs } from "@/lib/settings";
import { audit } from "@/lib/log";

export const dynamic = "force-dynamic";

export const GET = route(async () => json({ prefs: await getPrefs() }));

export const POST = route(async (req: Request) => {
  const b = await body<{ prefs?: Partial<CorePrefs> }>(req);
  const cur = await getPrefs();
  const next: CorePrefs = { ...DEFAULT_PREFS, ...cur };
  if (typeof b.prefs?.recordExperience === "boolean") next.recordExperience = b.prefs.recordExperience;
  if (typeof b.prefs?.memoryInPrompts === "boolean") next.memoryInPrompts = b.prefs.memoryInPrompts;
  await setSetting("core.prefs", next);
  await audit({ actor: "user", action: "settings.prefs", risk: "LOW", decision: "ok", details: next as unknown as Record<string, unknown> });
  return json({ prefs: next });
});
