/** Real connectivity probe (server side). Any HTTP response counts as reachable. */
export interface NetCheck {
  host: string;
  ok: boolean;
  ms: number | null;
}
export interface NetStatus {
  online: boolean;
  checks: NetCheck[];
  at: number;
}

const HOSTS = ["https://en.wikipedia.org/", "https://api.groq.com/", "https://generativelanguage.googleapis.com/"];
let cache: NetStatus | null = null;

export function cachedNetwork(): NetStatus | null {
  return cache && Date.now() - cache.at < 60_000 ? cache : null;
}

export async function networkStatus(force = false): Promise<NetStatus> {
  if (!force && cache && Date.now() - cache.at < 15_000) return cache;
  const checks = await Promise.all(
    HOSTS.map(async (h): Promise<NetCheck> => {
      const t0 = Date.now();
      try {
        await fetch(h, { method: "HEAD", signal: AbortSignal.timeout(3500), redirect: "manual" });
        return { host: new URL(h).host, ok: true, ms: Date.now() - t0 };
      } catch {
        return { host: new URL(h).host, ok: false, ms: null };
      }
    }),
  );
  cache = { online: checks.some((c) => c.ok), checks, at: Date.now() };
  return cache;
}
