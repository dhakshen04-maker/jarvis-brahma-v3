import { body, json, route, str } from "@/lib/api";
import { agentOverview, getRun, startRun } from "@/lib/agents";
import { engineStatuses } from "@/lib/engines";
import { isGranted } from "@/lib/permissions";
import { isUuid } from "@/lib/util";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const id = new URL(req.url).searchParams.get("run");
  if (id) {
    if (!isUuid(id)) return json({ error: "invalid id" }, 400);
    const r = await getRun(id);
    return r ? json(r) : json({ error: "not found" }, 404);
  }
  const [overview, engines] = await Promise.all([agentOverview(), engineStatuses()]);
  return json({ ...overview, engines });
});

export const POST = route(async (req: Request) => {
  if (!(await isGranted("agents.run"))) return json({ error: "agents.run is not granted" }, 403);
  const goal = str((await body(req)).goal).trim();
  if (goal.length < 5) return json({ error: "describe the goal (min 5 characters)" }, 400);
  return json({ id: await startRun(goal) });
});
