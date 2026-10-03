/**
 * The demonstration world served the way the API serves it (T053): same paths, same
 * error format, so a page cannot tell the sources apart — and cannot come to depend on
 * something only one of them does. Used only by a build without `VITE_API_URL`, and
 * then the page says «Demo».
 */
import { CONFIG, DECLARATIONS, INCIDENT_DETAIL, POOLS, PROTOCOL_DETAILS } from './fixtures'
import { ApiError, type Source } from './source'

const notFound = (message: string, details: Record<string, unknown>): never => {
  throw new ApiError(404, 'NOT_FOUND', message, details)
}

const INCIDENTS = [INCIDENT_DETAIL.incident]

const route = (path: string, query: URLSearchParams): unknown => {
  if (path === '/health') return { ok: true, slot: INCIDENT_DETAIL.as_of.slot, lag_slots: 0 }
  if (path === '/config') return CONFIG
  if (path === '/pools') return POOLS

  const protocol = /^\/pools\/([^/]+)$/.exec(path)?.[1]
  if (protocol !== undefined) {
    return (
      PROTOCOL_DETAILS.find((d) => d.protocol.address === protocol) ??
      notFound('No such protocol', { address: protocol })
    )
  }

  const declared = /^\/protocols\/([^/]+)\/declarations$/.exec(path)?.[1]
  if (declared !== undefined) {
    return (
      DECLARATIONS.find((d) => d.protocol === declared) ??
      notFound('No such protocol', { address: declared })
    )
  }

  if (path === '/incidents') {
    const byProtocol = query.get('protocol')
    const byStatus = query.get('status')
    return {
      as_of: INCIDENT_DETAIL.as_of,
      incidents: INCIDENTS.filter(
        (i) =>
          (byProtocol === null || i.protocol === byProtocol) &&
          (byStatus === null || i.status === byStatus),
      ),
      next_cursor: null,
    }
  }

  const incident = /^\/incidents\/([^/]+)$/.exec(path)?.[1]
  if (incident !== undefined) {
    return INCIDENT_DETAIL.incident.address === incident
      ? INCIDENT_DETAIL
      : notFound('No such incident', { address: incident })
  }

  return notFound('No such endpoint', { path })
}

export const fixtureSource: Source = async (pathWithQuery) => {
  const url = new URL(pathWithQuery, 'http://fixtures.invalid')
  // Through JSON, as over the wire: nothing a page reads can be a shared object it mutates.
  return JSON.parse(JSON.stringify(route(decodeURIComponent(url.pathname), url.searchParams)))
}
