import type { FetchQueryOptions, QueryKey } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import {
  ApiError,
  ContractError,
  REFRESH_MS,
  type Source,
  createQueries,
  createQueryClient,
  httpSource,
  incidentRefetchInterval,
  retryDelay,
  shouldRetry,
} from './api'
import { fixtureSource } from './fixtureSource'
import { CONFIG, DECLARATIONS, INCIDENT_DETAIL, POOLS, PROTOCOL_DETAILS } from './fixtures'

/** Runs a query the way a page would, through a client with the app's defaults. */
const run = <T, K extends QueryKey>(options: FetchQueryOptions<T, Error, T, K>) =>
  createQueryClient().fetchQuery({ ...options, retry: false })

const fixtures = createQueries(fixtureSource)

/** A `fetch` that records what it was asked and answers as told. */
const fakeFetch = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const asked: string[] = []
  const impl = (async (url: string | URL | Request) => {
    asked.push(String(url))
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, { status, headers })
  }) as typeof fetch
  return { impl, asked }
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error,
  )

describe('the fixture source', () => {
  it('answers every read the pages make, and each answer passes the contract', async () => {
    expect(await run(fixtures.config())).toEqual(CONFIG)
    expect(await run(fixtures.pools())).toEqual(POOLS)
    for (const detail of PROTOCOL_DETAILS) {
      expect(await run(fixtures.protocol(detail.protocol.address))).toEqual(detail)
    }
    for (const declarations of DECLARATIONS) {
      expect(await run(fixtures.declarations(declarations.protocol))).toEqual(declarations)
    }
    expect(await run(fixtures.incident(INCIDENT_DETAIL.incident.address))).toEqual(INCIDENT_DETAIL)
    expect(await run(fixtures.health())).toMatchObject({ ok: true, lag_slots: 0 })
  })

  it('filters the incident list as the API does', async () => {
    const { incident } = INCIDENT_DETAIL
    const list = (query: Parameters<typeof fixtures.incidents>[0]) => run(fixtures.incidents(query))

    expect((await list({})).incidents).toEqual([incident])
    expect((await list({ protocol: incident.protocol })).incidents).toEqual([incident])
    expect((await list({ protocol: CONFIG.admin })).incidents).toEqual([])
    expect((await list({ status: 'open' })).incidents).toEqual([])
    expect((await list({ status: incident.status })).next_cursor).toBeNull()
  })

  it('refuses what does not exist in the API’s error format', async () => {
    const missing = await rejection(fixtureSource(`/pools/${CONFIG.admin}`))
    expect(missing).toBeInstanceOf(ApiError)
    expect(missing).toMatchObject({ status: 404, code: 'NOT_FOUND' })

    expect(await rejection(fixtureSource('/nope'))).toMatchObject({ status: 404 })
    expect(await rejection(fixtureSource(`/incidents/${CONFIG.admin}`))).toMatchObject({
      status: 404,
    })
  })

  it('hands out copies, so a page cannot edit the demonstration world', async () => {
    const pools = (await fixtureSource('/pools')) as typeof POOLS
    pools.pools.length = 0
    expect(POOLS.pools.length).toBeGreaterThan(0)
  })
})

describe('the HTTP source', () => {
  it('joins the base URL and the path, whatever the base ends with', async () => {
    for (const base of ['https://api.example', 'https://api.example/', 'https://api.example//']) {
      const { impl, asked } = fakeFetch(200, CONFIG)
      await run(createQueries(httpSource(base, impl)).config())
      expect(asked).toEqual(['https://api.example/config'])
    }
  })

  it('escapes path parameters and omits unset filters', async () => {
    const { impl, asked } = fakeFetch(200, {})
    const source = httpSource('https://api.example', impl)
    const queries = createQueries(source)
    await rejection(run(queries.protocol('a/b?c')))
    await rejection(run(queries.incidents({ status: 'open', protocol: undefined, limit: 5 })))
    await rejection(run(queries.incidents()))
    expect(asked).toEqual([
      'https://api.example/pools/a%2Fb%3Fc',
      'https://api.example/incidents?status=open&limit=5',
      'https://api.example/incidents',
    ])
  })

  it('turns the contract’s error format into an ApiError carrying its code', async () => {
    const body = { error: { code: 'NOT_FOUND', message: 'No such protocol', details: { a: 1 } } }
    const error = await rejection(httpSource('https://x', fakeFetch(404, body).impl)('/pools/p'))
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'No such protocol',
      details: { a: 1 },
      retryAfterSeconds: null,
    })
  })

  it('reads how long a 429 asks to wait', async () => {
    const body = {
      error: { code: 'RATE_LIMITED', message: 'Too many requests', details: {} },
    }
    const { impl } = fakeFetch(429, body, { 'Retry-After': '7' })
    expect(await rejection(httpSource('https://x', impl)('/pools'))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 7,
    })
  })

  it('still fails clearly when a proxy answers in its own words', async () => {
    const { impl } = fakeFetch(502, '<html>Bad gateway</html>')
    expect(await rejection(httpSource('https://x', impl)('/pools'))).toMatchObject({
      status: 502,
      code: 'HTTP',
    })
  })

  it('rejects a success the contract does not describe, naming the path', async () => {
    const withoutAsOf = { pools: [] }
    const queries = createQueries(httpSource('https://x', fakeFetch(200, withoutAsOf).impl))
    const error = await rejection(run(queries.pools()))
    expect(error).toBeInstanceOf(ContractError)
    expect((error as ContractError).message).toContain('/pools')
  })
})

describe('retries', () => {
  const status = (s: number) => new ApiError(s, 'X', 'x')

  it('gives up on an answer that will be the same next time', () => {
    expect(shouldRetry(0, status(400))).toBe(false)
    expect(shouldRetry(0, status(404))).toBe(false)
    expect(shouldRetry(0, new ContractError('/pools', null))).toBe(false)
  })

  it('tries again after a refusal, a server failure or a dropped connection', () => {
    expect(shouldRetry(0, status(429))).toBe(true)
    // The API answers 503 until its first census.
    expect(shouldRetry(0, status(503))).toBe(true)
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true)
  })

  it('stops after three', () => {
    expect(shouldRetry(2, status(503))).toBe(true)
    expect(shouldRetry(3, status(503))).toBe(false)
  })

  it('waits exactly as long as a 429 asked, and doubles otherwise', () => {
    expect(retryDelay(0, new ApiError(429, 'RATE_LIMITED', 'x', {}, 7))).toBe(7000)
    expect(retryDelay(0, status(503))).toBe(1000)
    expect(retryDelay(1, status(503))).toBe(2000)
    expect(retryDelay(10, status(503))).toBe(30_000)
  })
})

describe('refresh', () => {
  const withStatus = (status: 'open' | 'paid_out' | 'closed_no_payout') => ({
    ...INCIDENT_DETAIL,
    incident: { ...INCIDENT_DETAIL.incident, status },
  })

  it('polls an incident while it is open and stops once it is settled', () => {
    expect(incidentRefetchInterval(withStatus('open'))).toBe(REFRESH_MS.openIncident)
    expect(incidentRefetchInterval(withStatus('paid_out'))).toBe(false)
    expect(incidentRefetchInterval(withStatus('closed_no_payout'))).toBe(false)
    expect(incidentRefetchInterval(undefined)).toBe(REFRESH_MS.openIncident)
  })

  it('polls state slowly and the config not at all', () => {
    expect(fixtures.pools().refetchInterval).toBe(REFRESH_MS.state)
    expect(fixtures.protocol('p').refetchInterval).toBe(REFRESH_MS.state)
    expect(fixtures.config().refetchInterval).toBeUndefined()
  })

  it('fits a tab in the API’s allowance several times over', () => {
    // The busiest page: an open incident plus the pools behind the navigation.
    const perMinute = 60_000 / REFRESH_MS.openIncident + 60_000 / REFRESH_MS.state
    expect(perMinute).toBeLessThanOrEqual(60 / 4)
  })
})

describe('a source', () => {
  it('is all a page depends on: any function of a path will do', async () => {
    const calls: string[] = []
    const recording: Source = async (path) => {
      calls.push(path)
      return fixtureSource(path)
    }
    await run(createQueries(recording).pools())
    expect(calls).toEqual(['/pools'])
  })
})
