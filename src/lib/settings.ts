import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (rows.length === 0) return fallback;
    return rows[0].value as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export interface CorePrefs {
  /** Automatically write lessons to experience memory after failures/successes. */
  recordExperience: boolean;
  /** Include relevant non-sensitive memories in model prompts. */
  memoryInPrompts: boolean;
}

export const DEFAULT_PREFS: CorePrefs = { recordExperience: true, memoryInPrompts: true };

export async function getPrefs(): Promise<CorePrefs> {
  return { ...DEFAULT_PREFS, ...(await getSetting<Partial<CorePrefs>>("core.prefs", {})) };
}
