import { body, json, route, str } from "@/lib/api";
import { analyze, applySuggestion, decideSuggestion, evolutionReport } from "@/lib/evolution";
import { isUuid } from "@/lib/util";

export const dynamic = "force-dynamic";

export const GET = route(async () => json(await evolutionReport()));

export const POST = route(async (req: Request) => {
  const b = await body(req);
  const action = str(b.action);
  try {
    if (action === "analyze") return json(await analyze());
    const id = str(b.id);
    if (!isUuid(id)) return json({ error: "invalid id" }, 400);
    if (action === "decide") {
      await decideSuggestion(id, b.decision === "approve" ? "approve" : "reject");
      return json({ ok: true });
    }
    if (action === "apply") return json({ ok: true, result: await applySuggestion(id) });
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
