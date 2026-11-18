/** Minimal JSON-schema subset validator + helpers used by the skill system. Self-contained. */

export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  default?: unknown;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export function validateSchema(schema: Schema | undefined | null, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (!schema || Object.keys(schema).length === 0) return errors;
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = allowed.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) {
      errors.push(`${path}: expected ${allowed.join("|")}, got ${actual}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateSchema(schema.items, v, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined) errors.push(...validateSchema(sub, obj[key], `${path}.${key}`));
    }
  }
  return errors;
}

/** Coerce string values (e.g. regex capture groups) to the types declared by an object schema. */
export function coerceToSchema(schema: Schema | undefined, raw: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const t = schema?.properties?.[k]?.type;
    if (t === "number" || t === "integer") out[k] = Number(v);
    else if (t === "boolean") out[k] = /^(true|yes|1|on)$/i.test(v);
    else out[k] = v;
  }
  return out;
}

/** Subset match: objects must contain every expected key; arrays must match element-wise; primitives strictly equal. */
export function matchSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "number" && typeof actual === "number") return Math.abs(actual - expected) < 1e-9;
    return actual === expected;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchSubset(actual[i], e));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const a = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => k in a && matchSubset(a[k], v));
}

export interface SkillTestCase {
  name: string;
  input: unknown;
  /** Subset-matched against the output. */
  expect?: unknown;
  /** true = any error is acceptable; string = error message must contain it. */
  expectError?: boolean | string;
}
