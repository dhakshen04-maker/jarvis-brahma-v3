import { db } from "@/db";
import { agentRuns, agentTasks, approvals, auditLog, skillAcquisitions, systemLogs } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { json, route } from "@/lib/api";
import { systemInfo, systemResources } from "@/lib/tools/system";
import { providerStatuses } from "@/lib/models/router";
import { networkStatus } from "@/lib/net";
import { sandboxStats } from "@/lib/sandbox";
import { recordMetric } from "@/lib/log";
import { memoryStats } from "@/lib/memory/store";

export const dynamic = "force-dynamic";
let lastSample = 0;

export const GET = route(async () => {
  const [resources, providers, network, tasks, acqs, pending, errors, audits, mem] = await Promise.all([
    systemResources(),
    providerStatuses(),
    networkStatus(),
    db.select({ id: agentTasks.id, agent: agentTasks.agent, title: agentTasks.title, runId: agentTasks.runId, startedAt: agentTasks.startedAt }).from(agentTasks).where(eq(agentTasks.status, "running")),
    db.select({ id: skillAcquisitions.id, request: skillAcquisitions.request, phase: skillAcquisitions.phase }).from(skillAcquisitions).where(eq(skillAcquisitions.status, "running")),
    db.select({ id: approvals.id, tool: approvals.tool, risk: approvals.risk, summary: approvals.summary }).from(approvals).where(eq(approvals.status, "pending")),
    db.select().from(systemLogs).orderBy(desc(systemLogs.ts)).limit(30),
    db.select().from(auditLog).orderBy(desc(auditLog.ts)).limit(25),
    memoryStats(),
  ]);
  if (Date.now() - lastSample > 30_000) {
    lastSample = Date.now();
    void recordMetric("system.cpu", resources.cpuPercent);
    void recordMetric("system.ram", resources.ramPercent);
  }
  const runs = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.status, "running"));
  return json({ resources, info: systemInfo(), providers, network, activeTasks: { agentTasks: tasks, acquisitions: acqs, pendingApprovals: pending, runningRuns: runs.length, sandbox: sandboxStats() }, errors, audit: audits, memory: mem, serverTime: new Date().toISOString() });
});
