import { body, json, route, str } from "@/lib/api";
import { fetchPage, listResearch, rateSource, researchTopic, searchWeb } from "@/lib/research";
import { designExperiment, listExperiments, runExperiment } from "@/lib/engines";
import { isGranted } from "@/lib/permissions";
import { scanInjection, wrapUntrusted } from "@/lib/security";
import { truncate } from "@/lib/util";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export const GET = route(async () => {
  const [r, experiments] = await Promise.all([listResearch(), listExperiments()]);
  return json({ ...r, experiments });
});

export const POST = route(async (req: Request) => {
  const b = await body(req);
  const action = str(b.action);
  const needsWeb = ["search", "topic", "fetch"].includes(action);
  if (needsWeb && !(await isGranted("research.web"))) return json({ error: "research.web is not granted (Settings > Permissions)" }, 403);
  try {
    switch (action) {
      case "search": return json(await searchWeb(str(b.query)));
      case "topic": return json(await researchTopic(str(b.topic), { store: b.store === true }));
      case "fetch": {
        const p = await fetchPage(str(b.url));
        const rel = rateSource(p.url, p.text);
        const inj = scanInjection(p.text);
        return json({ url: p.url, title: p.title, domain: p.domain, headings: p.headings.slice(0, 20), excerpt: truncate(p.text, 1200), reliability: rel, injection: inj, safeForModel: wrapUntrusted(p.text, p.domain, 400).length > 0 });
      }
      case "experiment": return json(await runExperiment({ hypothesis: str(b.hypothesis), code: str(b.code), input: b.input, expect: b.expect, design: str(b.design) }));
      case "design": return json(await designExperiment(str(b.hypothesis)));
      default: return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
