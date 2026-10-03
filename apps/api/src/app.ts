// The HTTP surface, apart from the process that serves it, so tests drive it with
// `app.request` against an in-process database.

import type { Db } from '@mandate/db'
import { Hono } from 'hono'
import { errorBody } from './errors'
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
}: {
  db: Db
  tip: () => Promise<number>
  logger?: AppLogger
}) =>
  new Hono()
    .route('/', healthRoutes({ db, tip }))
    .route('/', poolRoutes(db))
    .route('/', declarationRoutes(db))
    .route('/', incidentRoutes(db))
    .notFound((c) => c.json(errorBody('NOT_FOUND', 'No such endpoint', { path: c.req.path }), 404))
    .onError((error, c) => {
      logger?.error({ path: c.req.path, error: String(error) }, 'request failed')
      // The cause stays in the log: a stack or a SQL message is not public data.
      return c.json(errorBody('INTERNAL', 'Internal error'), 500)
    })
