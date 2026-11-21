/**
 * Fixed-window rate limiter, in memory (one process). Good enough for a single self-hosted instance: it caps
 * floods and scripted abuse; it is not a distributed quota system.
 */
export type Limit = { max: number; windowSeconds: number };
export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export function createRateLimiter(now: () => number = Date.now, maxKeys = 50_000) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const prune = (t: number) => {
    for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
  };
  return {
    /** Counts one hit for `key` under `limit`. */
    take(key: string, limit: Limit): RateDecision {
      const t = now();
      if (windows.size >= maxKeys) prune(t);
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + limit.windowSeconds * 1000 };
        windows.set(key, w);
      }
      w.count++;
      if (w.count <= limit.max) return { ok: true };
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
    },
    get size() {
      return windows.size;
    },
  };
}

/** The client IP from X-Forwarded-For (first entry), as set by a trusted reverse proxy; else `fallback`. */
export function clientIp(forwardedFor: string | null | undefined, fallback = "direct"): string {
  const first = forwardedFor?.split(",")[0]?.trim();
  return first ? first.slice(0, 64) : fallback;
}
