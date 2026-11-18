import {
  pgTable,
  text,
  uuid,
  timestamp,
  jsonb,
  integer,
  boolean,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";

type J = Record<string, unknown>;
const id = () => uuid("id").primaryKey().defaultRandom();
const created = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updated = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

/** Key/value settings (model config, prefs). Never stores secrets - keys come from env only. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: updated(),
});

export const conversations = pgTable("conversations", {
  id: id(),
  title: text("title").notNull().default("New conversation"),
  createdAt: created(),
  updatedAt: updated(),
});

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    meta: jsonb("meta").$type<J>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [index("messages_conv_idx").on(t.conversationId, t.createdAt)],
);

/** Six memory layers share one table: short_term, long_term, project, skill, experience, knowledge. */
export const memories = pgTable(
  "memories",
  {
    id: id(),
    layer: text("layer").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    importance: integer("importance").notNull().default(3),
    sensitive: boolean("sensitive").notNull().default(false),
    shared: boolean("shared").notNull().default(false),
    contentHash: text("content_hash").notNull(),
    embedding: jsonb("embedding").$type<number[]>().notNull().default([]),
    projectId: uuid("project_id"),
    source: text("source").notNull().default("user"),
    version: integer("version").notNull().default(1),
    accessCount: integer("access_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("memories_layer_idx").on(t.layer), index("memories_hash_idx").on(t.contentHash)],
);

export const memoryVersions = pgTable(
  "memory_versions",
  {
    id: id(),
    memoryId: uuid("memory_id").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: created(),
  },
  (t) => [index("memory_versions_idx").on(t.memoryId)],
);

export const projects = pgTable("projects", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: created(),
  updatedAt: updated(),
});

export const skillCategories = pgTable("skill_categories", {
  name: text("name").primaryKey(),
  description: text("description").notNull().default(""),
  builtin: boolean("builtin").notNull().default(false),
  createdAt: created(),
});

export const skills = pgTable("skills", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  activeVersionId: uuid("active_version_id"),
  status: text("status").notNull().default("EXPERIMENTAL"),
  enabled: boolean("enabled").notNull().default(true),
  builtin: boolean("builtin").notNull().default(false),
  usageCount: integer("usage_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
});

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: id(),
    skillId: uuid("skill_id").notNull(),
    version: integer("version").notNull(),
    code: text("code").notNull(),
    inputSchema: jsonb("input_schema").$type<J>().notNull().default({}),
    outputSchema: jsonb("output_schema").$type<J>().notNull().default({}),
    tests: jsonb("tests").$type<J[]>().notNull().default([]),
    dependencies: jsonb("dependencies").$type<string[]>().notNull().default([]),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    triggers: jsonb("triggers").$type<string[]>().notNull().default([]),
    limitations: text("limitations").notNull().default(""),
    executionMethod: text("execution_method").notNull().default("sandbox-js"),
    status: text("status").notNull().default("EXPERIMENTAL"),
    validation: jsonb("validation").$type<J | null>(),
    changelog: text("changelog").notNull().default(""),
    origin: text("origin").notNull().default("manual"),
    createdAt: created(),
    testedAt: timestamp("tested_at", { withTimezone: true }),
  },
  (t) => [index("skill_versions_skill_idx").on(t.skillId)],
);

export const skillAcquisitions = pgTable("skill_acquisitions", {
  id: id(),
  request: text("request").notNull(),
  phase: text("phase").notNull().default("IDENTIFY"),
  status: text("status").notNull().default("running"),
  log: jsonb("log").$type<J[]>().notNull().default([]),
  data: jsonb("data").$type<J>().notNull().default({}),
  skillId: uuid("skill_id"),
  error: text("error"),
  createdAt: created(),
  updatedAt: updated(),
});

export const agentRuns = pgTable("agent_runs", {
  id: id(),
  goal: text("goal").notNull(),
  template: text("template").notNull(),
  status: text("status").notNull().default("running"),
  result: jsonb("result").$type<J | null>(),
  error: text("error"),
  createdAt: created(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: id(),
    runId: uuid("run_id").notNull(),
    key: text("key").notNull(),
    agent: text("agent").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull().default(""),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    optional: boolean("optional").notNull().default(false),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    input: jsonb("input").$type<J>().notNull().default({}),
    result: jsonb("result").$type<J | null>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index("agent_tasks_run_idx").on(t.runId)],
);

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: id(),
    runId: uuid("run_id").notNull(),
    taskId: uuid("task_id"),
    fromAgent: text("from_agent").notNull(),
    toAgent: text("to_agent").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<J>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [index("agent_messages_run_idx").on(t.runId)],
);

export const researchSources = pgTable("research_sources", {
  id: id(),
  url: text("url").notNull().unique(),
  title: text("title").notNull().default(""),
  domain: text("domain").notNull().default(""),
  reliability: text("reliability").notNull().default("unknown"),
  reliabilityScore: integer("reliability_score").notNull().default(0),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  excerpt: text("excerpt").notNull().default(""),
  topic: text("topic").notNull().default(""),
  injectionFlags: jsonb("injection_flags").$type<string[]>().notNull().default([]),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});

export const researchReports = pgTable("research_reports", {
  id: id(),
  topic: text("topic").notNull(),
  summary: text("summary").notNull(),
  sourceIds: jsonb("source_ids").$type<string[]>().notNull().default([]),
  knowledgeMap: jsonb("knowledge_map").$type<J>().notNull().default({}),
  operational: boolean("operational").notNull().default(false),
  skillId: uuid("skill_id"),
  createdAt: created(),
});

export const experiments = pgTable("experiments", {
  id: id(),
  hypothesis: text("hypothesis").notNull(),
  design: text("design").notNull().default(""),
  code: text("code").notNull(),
  input: jsonb("input").$type<unknown>(),
  result: jsonb("result").$type<J | null>(),
  outcome: text("outcome").notNull().default("pending"),
  notes: text("notes").notNull().default(""),
  createdAt: created(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    tool: text("tool").notNull().default(""),
    risk: text("risk").notNull().default("LOW"),
    decision: text("decision").notNull(),
    details: jsonb("details").$type<J>().notNull().default({}),
  },
  (t) => [index("audit_ts_idx").on(t.ts)],
);

export const approvals = pgTable("approvals", {
  id: id(),
  tool: text("tool").notNull(),
  args: jsonb("args").$type<J>().notNull().default({}),
  argsHash: text("args_hash").notNull(),
  risk: text("risk").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull().default("pending"),
  result: jsonb("result").$type<J | null>(),
  createdAt: created(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const permissionGrants = pgTable("permission_grants", {
  capability: text("capability").primaryKey(),
  granted: boolean("granted").notNull(),
  updatedAt: updated(),
});

export const metrics = pgTable(
  "metrics",
  {
    id: id(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    name: text("name").notNull(),
    value: doublePrecision("value").notNull().default(1),
    labels: jsonb("labels").$type<J>().notNull().default({}),
  },
  (t) => [index("metrics_name_ts_idx").on(t.name, t.ts)],
);

export const modelUsage = pgTable(
  "model_usage",
  {
    id: id(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    task: text("task").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    estimated: boolean("estimated").notNull().default(false),
    latencyMs: integer("latency_ms").notNull().default(0),
    status: text("status").notNull(),
    error: text("error"),
  },
  (t) => [index("model_usage_ts_idx").on(t.ts)],
);

export const evolutionSuggestions = pgTable("evolution_suggestions", {
  id: id(),
  type: text("type").notNull(),
  key: text("key").notNull(),
  title: text("title").notNull(),
  rationale: text("rationale").notNull(),
  evidence: jsonb("evidence").$type<J>().notNull().default({}),
  payload: jsonb("payload").$type<J>().notNull().default({}),
  status: text("status").notNull().default("proposed"),
  result: jsonb("result").$type<J | null>(),
  createdAt: created(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const devices = pgTable("devices", {
  id: id(),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  tokenHash: text("token_hash").notNull(),
  granted: jsonb("granted").$type<string[]>().notNull().default([]),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  createdAt: created(),
});

export const deviceCommands = pgTable(
  "device_commands",
  {
    id: id(),
    deviceId: uuid("device_id").notNull(),
    command: text("command").notNull(),
    args: jsonb("args").$type<J>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    result: jsonb("result").$type<J | null>(),
    createdAt: created(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("device_commands_idx").on(t.deviceId, t.status)],
);

export const systemLogs = pgTable(
  "system_logs",
  {
    id: id(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    level: text("level").notNull(),
    source: text("source").notNull(),
    message: text("message").notNull(),
    details: jsonb("details").$type<J>().notNull().default({}),
  },
  (t) => [index("system_logs_ts_idx").on(t.ts)],
);
