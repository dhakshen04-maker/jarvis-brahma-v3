import { json, route } from "@/lib/api";
import { milestoneStatus } from "@/lib/status";
import { runSelfCheck } from "@/lib/selfcheck";
import { listTools } from "@/lib/tools";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = route(async () => json({ milestones: await milestoneStatus(), tools: listTools() }));

/** Runs the server-verifiable acceptance checks against the live system. */
export const POST = route(async () => json({ results: await runSelfCheck(), ranAt: new Date().toISOString() }));
