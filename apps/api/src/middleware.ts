// Rate limit on the public API (T052, docs/PLAN.md → Безпека): 60 requests a minute per
// source address, counted in this process.
//
// Decided 2026-10-03: every path is limited, `/health` and unknown paths included.
// `/health` asks the cluster for its tip, so leaving it open would leave the one RPC
// call a route makes open with it; an unknown path counts so that probing for routes is
// not free. The limiter is mounted on everything, so a route added later is limited
// without anybody remembering to.
//
// In memory, and exact for one reason: the free plan runs a single instance. With two,
// each would count its own callers and the effective limit would double.

import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, MiddlewareHandler } from 'hono'
import { fail } from './errors'

export const REQUESTS_PER_MINUTE = 60

const WINDOW_MS = 60_000

/**
 * A token bucket rather than a counter per calendar minute: a counter lets a caller spend
 * one window in its last second and the next in its first — twice the rate. The bucket
 * refills continuously, so the average is the limit and the burst is the capacity.
 */
export interface Bucket {
  readonly tokens: number
  readonly updatedAt: number
}

export interface Verdict {
  readonly allowed: boolean
  /** Until one token is back. Zero when allowed. */
  readonly retryAfterMs: number
  readonly bucket: Bucket
}

/** The decision itself, pure, so each case is a test rather than a timing experiment. */
export const take = (bucket: Bucket | undefined, capacity: number, now: number): Verdict => {
  const elapsed = bucket === undefined ? 0 : Math.max(0, now - bucket.updatedAt)
  const tokens =
    bucket === undefined
      ? capacity
      : Math.min(capacity, bucket.tokens + (elapsed * capacity) / WINDOW_MS)

  if (tokens >= 1) {
    return { allowed: true, retryAfterMs: 0, bucket: { tokens: tokens - 1, updatedAt: now } }
  }
  return {
    allowed: false,
    retryAfterMs: Math.ceil(((1 - tokens) * WINDOW_MS) / capacity),
    bucket: { tokens, updatedAt: now },
  }
}

/** A few dozen bytes each. The keys are addresses a caller picks, so the map is bounded. */
export const MAX_BUCKETS = 10_000

export interface BucketStore {
  take(id: string, now: number): Verdict
  readonly size: number
}

export const createBucketStore = (
  capacity = REQUESTS_PER_MINUTE,
  maxBuckets = MAX_BUCKETS,
): BucketStore => {
  const buckets = new Map<string, Bucket>()

  // A bucket untouched for a whole window is full, which is indistinguishable from a
  // caller never seen, so dropping it forgets nothing. Only when that is not enough — the
  // limit is busy right now — are the oldest evicted, and their callers get their
  // allowance back early: cheaper than unbounded memory.
  const sweep = (now: number) => {
    for (const [id, bucket] of buckets) {
      if (now - bucket.updatedAt >= WINDOW_MS) buckets.delete(id)
    }
    if (buckets.size <= maxBuckets) return
    const oldestFirst = [...buckets].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [id] of oldestFirst.slice(0, buckets.size - maxBuckets)) buckets.delete(id)
  }

  return {
    take: (id, now) => {
      const verdict = take(buckets.get(id), capacity, now)
      buckets.set(id, verdict.bucket)
      if (buckets.size > maxBuckets) sweep(now)
      return verdict
    },
    get size() {
      return buckets.size
    },
  }
}

/**
 * How many entries the hosting platform appends to `x-forwarded-for` after the caller.
 *
 * **0 since T059 (2026-10-07): the api runs behind Caddy on our own VM.** Caddy trusts no
 * proxy by default, so it drops whatever `x-forwarded-for` a caller sent and passes on
 * exactly one entry — the caller's own address, read from the socket. Nothing sits after
 * it. On Render it was 1, measured there on 2026-09-25: the last entry was a platform
 * proxy that wandered between addresses, and reading it handed one client several buckets.
 *
 * A constant rather than an environment variable: a value larger than the truth makes the
 * limit bypassable with a forged header, and nothing but a live measurement shows that.
 * Measure after every change of host — drain the bucket, wait a minute, count what is
 * served: 60 means one bucket, 120 two — and send a forged header while doing it.
 */
export const TRUSTED_PROXY_HOPS = 0

/** `ip:port` and `[v6]:port` to the bare address, or each connection is a new bucket. */
const withoutPort = (hop: string): string => {
  const bracketed = /^\[(.+)](?::\d+)?$/.exec(hop)
  if (bracketed?.[1] !== undefined) return bracketed[1]
  // A bare IPv6 address has several colons and no port.
  const parts = hop.split(':')
  return parts.length === 2 && /^\d+$/.test(parts[1] ?? '') ? (parts[0] ?? hop) : hop
}

/** Loopback, RFC 1918, link-local, CGNAT and their IPv6 kin: ours, never a caller's. */
const INTERNAL = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
]

const isInternal = (hop: string) => INTERNAL.some((range) => range.test(hop))

/**
 * The caller's address from `x-forwarded-for`, or `undefined` when there is none.
 *
 * Counted from the end, never from the start: whatever a caller writes into the header
 * stays to the left of what the edge appends, so no invented value becomes the one we
 * count by. A private tail is stepped over first, however long, then
 * `TRUSTED_PROXY_HOPS` public entries. A chain shorter than that — local, or a single
 * proxy — yields its first entry; in production a caller can only make it longer.
 */
export const addressFromForwardedFor = (
  header: string | undefined,
  hops: number = TRUSTED_PROXY_HOPS,
): string | undefined => {
  const entries = (header ?? '')
    .split(',')
    .map((hop) => withoutPort(hop.trim()))
    .filter((hop) => hop.length > 0)
  if (entries.length === 0) return undefined

  let end = entries.length
  while (end > 1 && isInternal(entries[end - 1] ?? '')) end -= 1
  return entries[Math.max(0, end - 1 - hops)]
}

/** Without a proxy in front — a local run — the socket is the caller. */
const socketAddress = (c: Context): string | undefined => {
  try {
    return getConnInfo(c).remote.address
  } catch {
    // `app.request` in tests has no socket.
    return undefined
  }
}

export const clientAddress = (c: Context): string =>
  addressFromForwardedFor(c.req.header('x-forwarded-for')) ?? socketAddress(c) ?? 'unknown'

export interface RateLimitOptions {
  /** Tests only. */
  readonly now?: () => number
  /** Tests only. */
  readonly addressOf?: (c: Context) => string
  readonly perMinute?: number
  readonly maxBuckets?: number
}

export const rateLimit = (options: RateLimitOptions = {}): MiddlewareHandler => {
  const buckets = createBucketStore(options.perMinute, options.maxBuckets)
  const now = options.now ?? Date.now
  const addressOf = options.addressOf ?? clientAddress

  return async (c, next) => {
    const verdict = buckets.take(addressOf(c), now())
    if (verdict.allowed) return next()

    const seconds = Math.ceil(verdict.retryAfterMs / 1000)
    c.header('Retry-After', String(seconds))
    return fail(c, 429, 'RATE_LIMITED', 'Too many requests', { retry_after_seconds: seconds })
  }
}
