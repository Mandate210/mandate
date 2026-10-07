import { errorResponseSchema } from '@mandate/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app'
import {
  type Bucket,
  REQUESTS_PER_MINUTE,
  TRUSTED_PROXY_HOPS,
  addressFromForwardedFor,
  createBucketStore,
  take,
} from './middleware'
import { type TestDb, openTestDb } from './test-db'

const T0 = 1_000_000
const MINUTE = 60_000

describe('take', () => {
  it('lets a fresh caller spend the whole capacity and no more', () => {
    let bucket: Bucket | undefined
    for (let i = 0; i < 5; i += 1) {
      const verdict = take(bucket, 5, T0)
      expect(verdict.allowed).toBe(true)
      expect(verdict.retryAfterMs).toBe(0)
      bucket = verdict.bucket
    }
    expect(take(bucket, 5, T0).allowed).toBe(false)
  })

  it('says how long the refusal lasts: one token’s worth of time', () => {
    const empty: Bucket = { tokens: 0, updatedAt: T0 }
    expect(take(empty, 60, T0).retryAfterMs).toBe(1000)
    expect(take(empty, 10, T0).retryAfterMs).toBe(6000)
    expect(take({ tokens: 0.5, updatedAt: T0 }, 60, T0).retryAfterMs).toBe(500)
    // Rounded up: a caller who retries on time must find the token there.
    expect(take(empty, 7, T0).retryAfterMs).toBe(8572)
  })

  it('refills continuously, so a minute’s average is the limit', () => {
    const empty: Bucket = { tokens: 0, updatedAt: T0 }
    expect(take(empty, 60, T0 + 999).allowed).toBe(false)
    expect(take(empty, 60, T0 + 1000).allowed).toBe(true)
  })

  it('never fills past the capacity, however long the caller was away', () => {
    const verdict = take({ tokens: 0, updatedAt: T0 }, 60, T0 + 10 * MINUTE)
    expect(verdict.bucket.tokens).toBe(59)
  })

  it('treats a clock that went back as no time passing, not as a debt', () => {
    const verdict = take({ tokens: 3, updatedAt: T0 }, 60, T0 - MINUTE)
    expect(verdict).toMatchObject({ allowed: true, bucket: { tokens: 2 } })
  })
})

describe('createBucketStore', () => {
  it('keeps one bucket per caller', () => {
    const store = createBucketStore(2)
    expect(store.take('a', T0).allowed).toBe(true)
    expect(store.take('a', T0).allowed).toBe(true)
    expect(store.take('a', T0).allowed).toBe(false)
    expect(store.take('b', T0).allowed).toBe(true)
  })

  it('drops full buckets first when it outgrows its bound', () => {
    const store = createBucketStore(1, 2)
    store.take('old', T0)
    store.take('recent', T0 + MINUTE)
    store.take('new', T0 + MINUTE)
    // `old` refilled a minute ago, so forgetting it forgot nothing.
    expect(store.size).toBe(2)
    expect(store.take('recent', T0 + MINUTE).allowed).toBe(false)
    expect(store.take('new', T0 + MINUTE).allowed).toBe(false)
  })

  it('evicts the oldest when every bucket is busy, and stays bounded', () => {
    const store = createBucketStore(1, 2)
    store.take('a', T0)
    store.take('b', T0 + 1)
    store.take('c', T0 + 2)
    expect(store.size).toBe(2)
    expect(store.take('a', T0 + 3).allowed).toBe(true)
  })
})

describe('addressFromForwardedFor — behind Caddy, the deployed host', () => {
  it('trusts no platform hop: Caddy passes the caller and nothing after it', () => {
    expect(TRUSTED_PROXY_HOPS).toBe(0)
  })

  it('reads the caller as the last entry', () => {
    expect(addressFromForwardedFor('203.0.113.7')).toBe('203.0.113.7')
  })

  // Caddy drops a forged header itself; were one ever to reach us appended to, the
  // caller's own address is still the entry counted.
  it('cannot be forged: entries a caller prepends stay to the left', () => {
    for (const forged of ['1.1.1.1', '1.1.1.1, 2.2.2.2']) {
      expect(addressFromForwardedFor(`${forged}, 203.0.113.7`)).toBe('203.0.113.7')
    }
  })

  it('steps over a private tail — Caddy and the api share a loopback', () => {
    expect(addressFromForwardedFor('203.0.113.7, 127.0.0.1')).toBe('203.0.113.7')
  })
})

describe('addressFromForwardedFor — one platform hop, as measured on Render', () => {
  const RENDER_HOPS = 1

  it('reads the caller one step back from the end', () => {
    expect(addressFromForwardedFor('203.0.113.7, 216.24.57.4', RENDER_HOPS)).toBe('203.0.113.7')
  })

  it('cannot be forged: entries a caller prepends stay to the left', () => {
    for (const forged of ['1.1.1.1', '1.1.1.1, 2.2.2.2', '9.9.9.9, 8.8.8.8, 7.7.7.7']) {
      expect(addressFromForwardedFor(`${forged}, 203.0.113.7, 216.24.57.4`, RENDER_HOPS)).toBe(
        '203.0.113.7',
      )
    }
  })

  it('gives one caller one address whichever platform proxy carried the request', () => {
    const seen = new Set(
      ['216.24.57.4', '216.24.57.252', '216.24.60.0'].map((proxy) =>
        addressFromForwardedFor(`203.0.113.7, ${proxy}`, RENDER_HOPS),
      ),
    )
    expect([...seen]).toEqual(['203.0.113.7'])
  })

  it('steps over a private tail before counting the platform hop', () => {
    expect(
      addressFromForwardedFor('203.0.113.7, 216.24.57.4, 10.0.0.3, 172.16.4.1', RENDER_HOPS),
    ).toBe('203.0.113.7')
    expect(
      addressFromForwardedFor('203.0.113.7, 216.24.57.4, 127.0.0.1, fd12:3456::1', RENDER_HOPS),
    ).toBe('203.0.113.7')
  })

  it('falls back to the first entry when the chain is shorter than the hops', () => {
    expect(addressFromForwardedFor('203.0.113.7', RENDER_HOPS)).toBe('203.0.113.7')
  })
})

describe('addressFromForwardedFor — either host', () => {
  it('drops ports, so a caller is not a new bucket per connection', () => {
    expect(addressFromForwardedFor('203.0.113.7:51234')).toBe('203.0.113.7')
    expect(addressFromForwardedFor('[2001:db8::7]:443')).toBe('2001:db8::7')
    expect(addressFromForwardedFor('2001:db8::7')).toBe('2001:db8::7')
  })

  it('has no answer without the header, so the socket decides', () => {
    expect(addressFromForwardedFor(undefined)).toBeUndefined()
    expect(addressFromForwardedFor(' , ')).toBeUndefined()
  })
})

describe('mounted in the app', () => {
  let testDb: TestDb

  beforeAll(async () => {
    testDb = await openTestDb()
  })

  afterAll(async () => {
    await testDb.close()
  })

  /** A frozen clock: nothing refills while the test runs. */
  const frozenApp = () => {
    let tipCalls = 0
    const app = createApp({
      db: testDb.db,
      tip: async () => {
        tipCalls += 1
        return 100
      },
      limit: { now: () => T0 },
    })
    return { app, tipCalls: () => tipCalls }
  }

  /** As Caddy hands a request over: the caller's own address, and nothing else. */
  const from = (address: string) => ({
    headers: { 'x-forwarded-for': address },
  })

  it('refuses the 61st request of a minute in the contract’s error format', async () => {
    const { app } = frozenApp()
    for (let i = 0; i < REQUESTS_PER_MINUTE; i += 1) {
      expect((await app.request('/nope', from('203.0.113.7'))).status).toBe(404)
    }

    const refused = await app.request('/nope', from('203.0.113.7'))
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('1')
    expect(errorResponseSchema.parse(await refused.json())).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests',
        details: { retry_after_seconds: 1 },
      },
    })
  })

  it('counts unknown paths and /health against one allowance', async () => {
    const { app, tipCalls } = frozenApp()
    for (let i = 0; i < REQUESTS_PER_MINUTE; i += 1) {
      await app.request(i % 2 === 0 ? '/nope' : '/health', from('203.0.113.7'))
    }
    const callsBefore = tipCalls()

    const refused = await app.request('/health', from('203.0.113.7'))
    expect(refused.status).toBe(429)
    // Refused before the route, so the RPC is not asked.
    expect(tipCalls()).toBe(callsBefore)
  })

  it('keeps callers apart, and a forged header buys no fresh allowance', async () => {
    const { app } = frozenApp()
    for (let i = 0; i < REQUESTS_PER_MINUTE; i += 1) {
      await app.request('/nope', from(`198.51.100.${i}, 203.0.113.7`))
    }
    expect((await app.request('/nope', from('198.51.100.250, 203.0.113.7'))).status).toBe(429)
    expect((await app.request('/nope', from('203.0.113.8'))).status).toBe(404)
  })

  it('lets a page from any origin read an answer, a refusal included', async () => {
    const { app } = frozenApp()
    const origin = { Origin: 'https://reader.example' }
    const ok = await app.request('/nope', { headers: origin })
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
    // No credentials: `*` with them is refused by every browser, and there are none to send.
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull()

    for (let i = 1; i < REQUESTS_PER_MINUTE; i += 1) await app.request('/nope', { headers: origin })
    const refused = await app.request('/nope', { headers: origin })
    expect(refused.status).toBe(429)
    expect(refused.headers.get('access-control-allow-origin')).toBe('*')
    // Without this a script sees the 429 but not how long to wait.
    expect(refused.headers.get('access-control-expose-headers')).toContain('Retry-After')
  })

  it('answers a preflight for reading, and offers nothing that writes', async () => {
    const { app } = frozenApp()
    const preflight = await app.request('/pools', {
      method: 'OPTIONS',
      headers: { Origin: 'https://reader.example', 'Access-Control-Request-Method': 'GET' },
    })
    expect(preflight.status).toBe(204)
    const methods = preflight.headers.get('access-control-allow-methods') ?? ''
    expect(methods.split(',').sort()).toEqual(['GET', 'HEAD', 'OPTIONS'])
  })

  it('gives every app its own buckets', async () => {
    const first = frozenApp().app
    for (let i = 0; i < REQUESTS_PER_MINUTE; i += 1) await first.request('/nope')
    expect((await first.request('/nope')).status).toBe(429)
    expect((await frozenApp().app.request('/nope')).status).toBe(404)
  })
})
