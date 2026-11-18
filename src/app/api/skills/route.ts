import { body, json, route, str } from "@/lib/api";
import { createSkill, ensureCategory, listCategories, listSkills, type NewSkillInput } from "@/lib/skills/registry";
import { listAcquisitions, startAcquisition } from "@/lib/skills/acquisition";
import { isGranted } from "@/lib/permissions";
import { modelAvailable } from "@/lib/models/router";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const [skills, categories, acquisitions, model] = await Promise.all([listSkills(), listCategories(), listAcquisitions(), modelAvailable("coding")]);
  return json({ skills, categories, acquisitions, modelAvailable: model });
});

export const POST = route(async (req: Request) => {
  const b = await body(req);
  const action = str(b.action, "create");
  if (action === "category") {
    if (!str(b.name).trim()) return json({ error: "name required" }, 400);
    await ensureCategory(str(b.name).trim().slice(0, 60), str(b.description).slice(0, 200));
    return json({ ok: true });
  }
  if (!(await isGranted("skill.create"))) return json({ error: "skill.create is not granted" }, 403);
  if (action === "acquire") {
    const request = str(b.request).trim();
    if (request.length < 5) return json({ error: "describe the capability (min 5 characters)" }, 400);
    return json({ id: await startAcquisition(request) });
  }
  try {
    const r = await createSkill(b as unknown as NewSkillInput, "manual");
    return json(r);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
