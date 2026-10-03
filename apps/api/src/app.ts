// The HTTP surface, apart from the process that serves it, so tests drive it with
// `app.request` against an in-process database.

import type { Db } from '@mandate/db'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { errorBody } from './errors'
import { type RateLimitOptions, rateLimit } from './middleware'
import { configRoutes } from './routes/config'
import { declarationRoutes } from './routes/declarations'
import { healthRoutes } from './routes/health'
import { incidentRoutes } from './routes/incidents'
import { poolRoutes } from './routes/pools'

export interface AppLogger {
  error(object: object, message: string): void
}

export const createApp = ({
  db,
  tip,
  logger,
  limit,
}: {
  db: Db
  tip: () => Promise<number>
  logger?: AppLogger
  limit?: RateLimitOptions
}) =>
  new Hono()
    // Any origin: the data is public (FR-030), there are no cookies to protect, and SC-007
    // expects third parties to read it with tools of their own. Before the limit, so a
    // browser can read a 429 too, and `Retry-After` is exposed for the same reason.
    .use(
      '*',
      cors({
        origin: '*',
        allowMethods: ['GET', 'HEAD', 'OPTIONS'],
        exposeHeaders: ['Retry-After'],
      }),
    )
    // Then the limit, so a refused request costs no query and no RPC call.
    .use('*', rateLimit(limit))
    .route('/', healthRoutes({ db, tip }))
    .route('/', configRoutes(db))
    .route('/', poolRoutes(db))
    .route('/', declarationRoutes(db))
    .route('/', incidentRoutes(db))
    .notFound((c) => c.json(errorBody('NOT_FOUND', 'No such endpoint', { path: c.req.path }), 404))
    .onError((error, c) => {
      logger?.error({ path: c.req.path, error: String(error) }, 'request failed')
      // The cause stays in the log: a stack or a SQL message is not public data.
      return c.json(errorBody('INTERNAL', 'Internal error'), 500)
    })
