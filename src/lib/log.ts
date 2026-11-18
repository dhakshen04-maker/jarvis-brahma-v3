import { db } from "@/db";
import { auditLog, metrics, systemLogs } from "@/db/schema";
import { redactSecrets } from "@/lib/security";

type J = Record<string, unknown>;

function safe(details: J | undefined): J {
  if (!details) return {};
  try {
    return JSON.parse(redactSecrets(JSON.stringify(details))) as J;
  } catch {
    return {};
  }
}

/** Logging must never break the calling flow. */
export async function logEvent(level: "info" | "warn" | "error", source: string, message: string, details?: J) {
  try {
    await db.insert(systemLogs).values({ level, source, message: message.slice(0, 500), details: safe(details) });
  } catch {
    /* ignore */
  }
}

export async function recordMetric(name: string, value = 1, labels: J = {}) {
  try {
    await db.insert(metrics).values({ name, value, labels: safe(labels) });
  } catch {
    /* ignore */
  }
}

export async function audit(e: {
  actor: string;
  action: string;
  tool?: string;
  risk?: string;
  decision: string;
  details?: J;
}) {
  try {
    await db.insert(auditLog).values({
      actor: e.actor,
      action: e.action,
      tool: e.tool ?? "",
      risk: e.risk ?? "LOW",
      decision: e.decision,
      details: safe(e.details),
    });
  } catch {
    /* ignore */
  }
}
