/**
 * Lightweight in-memory sliding-window rate limiter for serverless API routes.
 * Each instance tracks a separate concern (e.g. sign-allocation vs upload).
 */
export function createRateLimiter({ windowMs = 60_000, max = 5 } = {}) {
  const hits = new Map();

  // Periodic cleanup to prevent unbounded growth (runs at most every 2 minutes)
  let lastCleanup = Date.now();
  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < 120_000) return;
    lastCleanup = now;
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs * 2) hits.delete(key);
    }
  }

  return function check(key) {
    cleanup();
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(key, { windowStart: now, count: 1 });
      return { allowed: true, remaining: max - 1 };
    }

    entry.count++;
    if (entry.count > max) {
      const retryAfterMs = windowMs - (now - entry.windowStart);
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    return { allowed: true, remaining: max - entry.count };
  };
}
