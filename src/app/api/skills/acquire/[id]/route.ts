import { body, json, route } from "@/lib/api";
import { getAcquisition, submitManualImplementation, type ManualSpec } from "@/lib/skills/acquisition";
import { isGranted } from "@/lib/permissions";
import { isUuid } from "@/lib/util";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "invalid id" }, 400);
  const a = await getAcquisition(id);
  return a ? json(a) : json({ error: "not found" }, 404);
});

/** Submit a manual implementation for a blocked acquisition; it goes through the same sandbox + validator. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "invalid id" }, 400);
  if (!(await isGranted("skill.create"))) return json({ error: "skill.create is not granted" }, 403);
  const b = (await body(req)) as unknown as ManualSpec;
  if (!b.code || !b.slug || !b.name || !Array.isArray(b.tests)) return json({ error: "name, slug, code and tests are required" }, 400);
  await submitManualImplementation(id, { ...b, description: b.description || b.name, category: b.category || "General problem-solving", inputSchema: b.inputSchema ?? {}, outputSchema: b.outputSchema ?? {}, triggers: b.triggers ?? [], limitations: b.limitations ?? "" });
  return json(await getAcquisition(id));
});
