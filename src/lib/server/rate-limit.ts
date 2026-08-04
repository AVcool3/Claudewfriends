/**
 * Sliding-window rate limiting.
 *
 * ============================ DEPLOYMENT NOTE ============================
 * These counters live in the memory of ONE Node process. That is correct for a
 * single-instance deployment and for local development, and it is wrong the
 * moment the app is scaled horizontally or moved to a serverless runtime that
 * spins up isolates per request: N instances multiply every limit by N, and a
 * cold start resets the window entirely.
 *
 * To go multi-instance, replace the `store` below with either
 *   - Redis: `INCR` + `EXPIRE`, or a sorted set of hit timestamps per key, or
 *   - Postgres: a `rate_limit_hits (key, at)` table plus a windowed `count(*)`,
 *     which keeps the dependency list short at the cost of a round trip.
 * `checkRateLimit`'s signature is deliberately synchronous-friendly but small;
 * swapping it for an async version is a one-file change plus `await` at the
 * call sites in `security-validator.ts`.
 * =========================================================================
 */

export interface RateLimitVerdict {
  allowed: boolean
  retryAfterSeconds: number
  remaining: number
}

export const LIMITS = {
  messagePerUser: { limit: 20, windowMs: 60_000 },
  claudePerRoom: { limit: 30, windowMs: 60_000 },
  invitePerRoom: { limit: 20, windowMs: 3_600_000 },
  roomCreatePerUser: { limit: 10, windowMs: 3_600_000 },
}

interface WindowEntry {
  /** Ascending hit timestamps inside the current window. */
  hits: number[]
  /** Retained so the sweep can expire an entry without knowing its caller. */
  windowMs: number
}

const SWEEP_INTERVAL_MS = 60_000

/**
 * A hard ceiling on distinct keys. Keys are derived from user and room ids, so
 * this is only reachable under abuse (or a bug that builds keys from unbounded
 * input) — but an unbounded Map in a long-lived process is a memory leak, so we
 * cap it rather than trust the key space.
 */
const MAX_KEYS = 50_000

interface RateLimitStore {
  entries: Map<string, WindowEntry>
  lastSweep: number
}

/**
 * Hung off `globalThis` because Next.js' dev server re-evaluates modules on hot
 * reload; a plain module-level Map would reset limits on every edit and, worse,
 * leave the old Map alive.
 */
const globalStore = globalThis as typeof globalThis & { __rateLimitStore?: RateLimitStore }

const store: RateLimitStore =
  globalStore.__rateLimitStore ?? (globalStore.__rateLimitStore = { entries: new Map(), lastSweep: 0 })

/**
 * Drops entries whose most recent hit has aged out. Runs lazily from
 * `checkRateLimit` rather than on a `setInterval`, because a timer would keep a
 * reference to the module alive across hot reloads and would fire in build
 * workers that never serve a request.
 */
function sweep(now: number): void {
  if (now - store.lastSweep < SWEEP_INTERVAL_MS) return
  store.lastSweep = now

  for (const [key, entry] of store.entries) {
    const newest = entry.hits[entry.hits.length - 1]
    if (newest === undefined || now - newest > entry.windowMs) {
      store.entries.delete(key)
    }
  }
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitVerdict {
  const now = Date.now()
  sweep(now)

  let entry = store.entries.get(key)
  if (!entry) {
    if (store.entries.size >= MAX_KEYS) {
      // Emergency purge: a full sweep regardless of the interval. If that still
      // leaves us at the ceiling we fail open, because a rate limiter that
      // denies every request under memory pressure is a self-inflicted outage.
      store.lastSweep = 0
      sweep(now)
      if (store.entries.size >= MAX_KEYS) {
        console.error('[rate-limit] key ceiling reached; failing open')
        return { allowed: true, retryAfterSeconds: 0, remaining: 0 }
      }
    }
    entry = { hits: [], windowMs }
    store.entries.set(key, entry)
  }

  // The window may have changed if a limit was retuned between deploys.
  entry.windowMs = windowMs

  const cutoff = now - windowMs
  // Hits are appended in time order, so the expired ones are always a prefix.
  let firstLive = 0
  while (firstLive < entry.hits.length && entry.hits[firstLive] <= cutoff) firstLive++
  if (firstLive > 0) entry.hits.splice(0, firstLive)

  if (entry.hits.length >= limit) {
    const oldest = entry.hits[0] ?? now
    const retryAfterMs = Math.max(0, oldest + windowMs - now)
    // A denied attempt is not recorded, so a client that keeps hammering does
    // not push its own window forward and lock itself out indefinitely.
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      remaining: 0,
    }
  }

  entry.hits.push(now)
  return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, limit - entry.hits.length) }
}

/** Test/administrative escape hatch; not used by request paths. */
export function resetRateLimits(): void {
  store.entries.clear()
  store.lastSweep = 0
}
