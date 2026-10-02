// One consistent read of the cache, and the moment it describes (T049).
//
// Decided 2026-10-02: `as_of` is the indexer's watermark — the later of the last census
// and the last followed transaction, with the cluster time of that slot — not the
// cluster tip. The cache can vouch for the moment it last read the chain and for no
// later one; a quiet program lets `as_of` age by up to a census interval, and the
// response says so instead of hiding it. Routes read nothing but the database.

import { type Db, schema } from '@mandate/db'
import type { AsOf } from '@mandate/shared'
import { desc, isNotNull } from 'drizzle-orm'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type ConfigRow = typeof schema.config.$inferSelect

/** The latest point at which the indexer read the chain, or `null` before its first census. */
export const readWatermark = async (db: Db | Tx): Promise<AsOf | null> => {
  const [cursor] = await db
    .select()
    .from(schema.indexerCursor)
    // A cursor whose slot the node could not date cannot anchor `in_force`; the other
    // one, or the next write, will.
    .where(isNotNull(schema.indexerCursor.blockTime))
    .orderBy(desc(schema.indexerCursor.lastSlot))
    .limit(1)
  if (cursor === undefined || cursor.blockTime === null) return null
  return { slot: cursor.lastSlot, unix_ts: cursor.blockTime }
}

export type Snapshot = { tx: Tx; asOf: AsOf; config: ConfigRow }

/**
 * Runs `read` inside one read-only REPEATABLE READ transaction, so every row it sees —
 * and the watermark — is from the same moment of the cache. Without it a response could
 * pair a pool the indexer has just rewritten with policies it has not reached yet.
 *
 * `null` until the cache holds a census: there is no moment to report yet.
 */
export const withSnapshot = <T>(db: Db, read: (snapshot: Snapshot) => Promise<T>) =>
  db.transaction(
    async (tx): Promise<T | null> => {
      const asOf = await readWatermark(tx)
      const [config] = await tx.select().from(schema.config).limit(1)
      if (asOf === null || config === undefined) return null
      return read({ tx, asOf, config })
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
