// One census of the program into the cache, then exit (T048).
//
//   pnpm --filter @mandate/api census
//
// The same pass the indexer runs on start and every ten minutes. For filling a fresh
// database — after a redeploy under a new program id (T075), or after dropping the
// cache on purpose — and for checking the cache against the chain by hand.

import { createDb } from '@mandate/db'
import { PROGRAM_ID } from '@mandate/sdk'
import { Connection } from '@solana/web3.js'
import { loadRepoEnv } from './env'
import { connectionIndexerRpc, createIndexer } from './indexer'

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

loadRepoEnv()

const main = async (): Promise<number> => {
  const connection = new Connection(required('SOLANA_RPC_URL'), 'finalized')
  const { db, close } = createDb(required('DATABASE_URL'))
  const indexer = createIndexer({
    rpc: connectionIndexerRpc(connection, PROGRAM_ID),
    db,
    programId: PROGRAM_ID,
  })
  const started = Date.now()
  const report = await indexer.census().finally(close)
  console.log(JSON.stringify({ ...report, seconds: (Date.now() - started) / 1000 }, null, 2))
  return report.unplaced === 0 ? 0 : 1
}

// `process.exitCode`, not `process.exit`: on Node 26 under Windows an exit with the
// RPC's sockets still open trips a libuv assertion and reports 127 instead.
process.exitCode = await main()
