// Public read-only API plus the indexer subscription (docs/PLAN.md → Архітектура).
//
// No authentication anywhere by design: every endpoint serves public data
// (FR-030) and every state change happens through a signed transaction (FR-034).
//
// T048 started the indexer; T049 the first routes, and T050…T052 add the rest.

import { serve } from '@hono/node-server'
import { createDb } from '@mandate/db'
import { PROGRAM_ID } from '@mandate/sdk'
import { Connection } from '@solana/web3.js'
import pino from 'pino'
import { createApp } from './app'
import { loadRepoEnv } from './env'
import { connectionIndexerRpc, createIndexer } from './indexer'

const logger = pino({ name: 'api' })

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

loadRepoEnv()

const main = async (): Promise<void> => {
  // The WS endpoint is passed explicitly: `Connection` derives one by swapping the
  // scheme and port and drops the query string, which is where providers keep the key.
  const connection = new Connection(required('SOLANA_RPC_URL'), {
    commitment: 'finalized',
    ...(process.env.SOLANA_WS_URL ? { wsEndpoint: process.env.SOLANA_WS_URL } : {}),
  })
  const { db, close } = createDb(required('DATABASE_URL'))
  const indexer = createIndexer({
    rpc: connectionIndexerRpc(connection, PROGRAM_ID),
    db,
    programId: PROGRAM_ID,
    logger,
  })
  // Listening before the first census: until it lands the routes answer 503, and after
  // a restart they serve the previous watermark — honestly dated by `as_of`.
  const app = createApp({ db, tip: () => connection.getSlot('confirmed'), logger })
  const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) =>
    logger.info({ port: info.port }, 'api listening'),
  )

  const report = await indexer.start()
  logger.info(report, 'indexer: first census')

  const shutdown = () => {
    server.close()
    indexer
      .stop()
      .then(close)
      .then(
        () => logger.info({}, 'indexer stopped'),
        (error: unknown) => logger.error({ error: String(error) }, 'indexer stop failed'),
      )
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

await main()
