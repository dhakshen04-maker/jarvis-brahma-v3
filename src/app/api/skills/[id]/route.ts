import { body, json, route, str } from "@/lib/api";
import { createDraftVersion, deleteSkill, getSkillDetail, promoteVersion, rollbackSkill, runSkill, setSkillEnabled, testVersion } from "@/lib/skills/registry";
import { improveSkill } from "@/lib/skills/acquisition";
import { isGranted } from "@/lib/permissions";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const d = await getSkillDetail(id);
  return d ? json(d) : json({ error: "not found" }, 404);
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const d = await getSkillDetail(id);
  if (!d) return json({ error: "not found" }, 404);
  if (!(await isGranted("skill.manage"))) return json({ error: "skill.manage is not granted" }, 403);
  try {
    await deleteSkill(d.skill.id);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const d = await getSkillDetail(id);
  if (!d) return json({ error: "not found" }, 404);
  const b = await body(req);
  const action = str(b.action);
  try {
    if (action === "run") {
      if (!(await isGranted("skill.execute"))) return json({ error: "skill.execute is not granted" }, 403);
      return json(await runSkill(d.skill.slug, b.input, { allowUntested: b.allowUntested === true, actor: "user" }));
    }
    if (!(await isGranted("skill.manage"))) return json({ error: "skill.manage is not granted" }, 403);
    switch (action) {
      case "test": return json(await testVersion(str(b.versionId) || d.activeVersionId!));
      case "promote": return json(await promoteVersion(str(b.versionId)));
      case "rollback": return json(await rollbackSkill(d.skill.id, str(b.versionId) || undefined));
      case "toggle": await setSkillEnabled(d.skill.id, b.enabled === true); return json({ ok: true });
      case "draft": return json(await createDraftVersion(d.skill.id, { code: b.code as string | undefined, tests: b.tests as never, inputSchema: b.inputSchema as never, outputSchema: b.outputSchema as never, triggers: b.triggers as string[] | undefined, limitations: b.limitations as string | undefined, changelog: str(b.changelog, "Manual draft") }, "manual"));
      case "improve": return json(await improveSkill(d.skill.id, str(b.feedback)));
      default: return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
