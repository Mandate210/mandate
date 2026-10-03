/**
 * The one place the pages get data from (T053): a source, the contract's schemas, and
 * the query options TanStack Query runs them with.
 *
 * Decided 2026-10-03: the source is chosen when the app is built. With `VITE_API_URL`
 * every response comes from the API; without it, from `fixtures.ts` through the same
 * paths and the same schemas, and only then does the page say «Demo». An API that does
 * not answer is an error on the page — never a quiet fallback to the fixtures, which
 * would present invented incidents as the chain's.
 *
 * Every response is parsed with the schema `@mandate/shared` holds the API to, so a
 * field the API stopped sending fails here, by name, instead of rendering as blank.
 */
import {
  type ConfigResponse,
  type DeclarationsResponse,
  type HealthResponse,
  type IncidentDetailResponse,
  type IncidentsQuery,
  type IncidentsResponse,
  type PoolsResponse,
  type ProtocolDetailResponse,
  configResponseSchema,
  declarationsResponseSchema,
  healthResponseSchema,
  incidentDetailResponseSchema,
  incidentsResponseSchema,
  poolsResponseSchema,
  protocolDetailResponseSchema,
} from '@mandate/shared'
import { QueryClient, queryOptions } from '@tanstack/react-query'
import { fixtureSource } from './fixtureSource'
import { ApiError, ContractError, type Source, httpSource } from './source'

export { ApiError, ContractError, type Source, httpSource }

const API_URL: string | undefined = import.meta.env.VITE_API_URL || undefined

/** True when the page shows the fixtures. The «Demo» banner says so exactly then. */
export const isDemo = API_URL === undefined

export const defaultSource: Source = API_URL === undefined ? fixtureSource : httpSource(API_URL)

/* ---------------------------------------------------------------- */
/* Refresh                                                           */
/* ---------------------------------------------------------------- */

/**
 * Decided 2026-10-03, by what changes while it is watched. The indexer follows the
 * program's logs at `finalized`, ~13 s behind the cluster, so asking more often shows
 * nothing new. One tab costs well under ten requests a minute, so several behind one
 * address stay inside the API's 60.
 */
export const REFRESH_MS = {
  /** An open incident, while attestations arrive and the payout may land. */
  openIncident: 10_000,
  /** Pools, lists, a settled incident's protocol: they move, but slowly. */
  state: 30_000,
} as const

/** `Config` changes when an attestor is admitted — rare enough for a refetch on focus. */
const CONFIG_STALE_MS = 5 * 60_000

/** Polls an incident while it is open, and stops once it is settled for good. */
export const incidentRefetchInterval = (data: IncidentDetailResponse | undefined) =>
  data === undefined || data.incident.status === 'open' ? REFRESH_MS.openIncident : false

/* ---------------------------------------------------------------- */
/* Queries                                                           */
/* ---------------------------------------------------------------- */

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown }
}

const incidentsPath = (query: Partial<IncidentsQuery>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const search = params.toString()
  return search === '' ? '/incidents' : `/incidents?${search}`
}

export const createQueries = (source: Source) => {
  const get =
    <T>(schema: Schema<T>, path: string) =>
    async (): Promise<T> => {
      const parsed = schema.safeParse(await source(path))
      if (!parsed.success) throw new ContractError(path, parsed.error)
      return parsed.data
    }
  const at = encodeURIComponent

  return {
    health: () =>
      queryOptions({
        queryKey: ['health'],
        queryFn: get<HealthResponse>(healthResponseSchema, '/health'),
        refetchInterval: REFRESH_MS.state,
      }),
    config: () =>
      queryOptions({
        queryKey: ['config'],
        queryFn: get<ConfigResponse>(configResponseSchema, '/config'),
        staleTime: CONFIG_STALE_MS,
      }),
    pools: () =>
      queryOptions({
        queryKey: ['pools'],
        queryFn: get<PoolsResponse>(poolsResponseSchema, '/pools'),
        refetchInterval: REFRESH_MS.state,
      }),
    protocol: (protocol: string) =>
      queryOptions({
        queryKey: ['pools', protocol],
        queryFn: get<ProtocolDetailResponse>(
          protocolDetailResponseSchema,
          `/pools/${at(protocol)}`,
        ),
        refetchInterval: REFRESH_MS.state,
      }),
    declarations: (protocol: string) =>
      queryOptions({
        queryKey: ['declarations', protocol],
        queryFn: get<DeclarationsResponse>(
          declarationsResponseSchema,
          `/protocols/${at(protocol)}/declarations`,
        ),
        refetchInterval: REFRESH_MS.state,
      }),
    incidents: (query: Partial<IncidentsQuery> = {}) =>
      queryOptions({
        queryKey: ['incidents', query],
        queryFn: get<IncidentsResponse>(incidentsResponseSchema, incidentsPath(query)),
        refetchInterval: REFRESH_MS.state,
      }),
    incident: (pubkey: string) =>
      queryOptions({
        queryKey: ['incidents', pubkey],
        queryFn: get<IncidentDetailResponse>(
          incidentDetailResponseSchema,
          `/incidents/${at(pubkey)}`,
        ),
        refetchInterval: (query) => incidentRefetchInterval(query.state.data),
      }),
  }
}

/** What the pages import: the queries over the source this build was made with. */
export const queries = createQueries(defaultSource)

/* ---------------------------------------------------------------- */
/* Retries                                                           */
/* ---------------------------------------------------------------- */

const MAX_RETRIES = 3

/**
 * A 4xx is the same answer next time — except 429, which says when to come back. A
 * response outside the contract is the same next time too. A 5xx or a dropped
 * connection may not be: the API answers 503 until its first census, for one.
 */
export const shouldRetry = (failures: number, error: unknown): boolean => {
  if (failures >= MAX_RETRIES) return false
  if (error instanceof ContractError) return false
  if (error instanceof ApiError) return error.status === 429 || error.status >= 500
  return true
}

/** After a 429, exactly as long as the API asked; otherwise doubling from a second. */
export const retryDelay = (failures: number, error: unknown): number => {
  if (error instanceof ApiError && error.retryAfterSeconds !== null) {
    return error.retryAfterSeconds * 1000
  }
  return Math.min(1000 * 2 ** failures, 30_000)
}

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay,
        staleTime: REFRESH_MS.openIncident,
        // A background tab spends no part of the visitor's allowance.
        refetchIntervalInBackground: false,
      },
    },
  })
