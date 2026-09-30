// Drizzle schema and connection factory.
//
// This database is a cache of on-chain state, never a source of truth: it can be
// dropped and rebuilt from the chain. Every row carries `updated_slot` so that
// an indexer restart is idempotent and never rolls state backwards
// (docs/PLAN.md → "Модель даних").
import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import type {
  PgColumn,
  PgDatabase,
  PgQueryResultHKT,
  PgTable,
  PgUpdateSetSource,
} from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export * from './schema'
export { schema }

/** Any Drizzle Postgres database over this schema — postgres-js in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

/**
 * The runtime connection. `prepare: false` because production goes through Supabase's
 * transaction pooler (port 6543), where a prepared statement does not survive the end
 * of the transaction that made it and the *second* query fails. Migrations take a
 * different URL — the session pooler on 5432 — see `drizzle.config.ts`.
 */
export const createDb = (url: string): { db: Db; close: () => Promise<void> } => {
  const client = postgres(url, { prepare: false })
  // `close` because postgres.js keeps idle connections open forever by default, and a
  // one-shot command that cannot release them never exits.
  return { db: drizzle(client, { schema }), close: () => client.end() }
}

/** A table mirroring one account type: addressed by the account, stamped with a slot. */
type AccountTable = PgTable & { address: PgColumn; updatedSlot: PgColumn }

/**
 * Writes account rows, replacing a stored row only when the incoming one is from the
 * same slot or a later one.
 *
 * The indexer hears about an account from more than one place — a backfill, a
 * subscription, a restart replaying both — and in no promised order. Without the slot
 * guard, a backfill finishing after a live update would put the older state back. The
 * same slot is let through: an RPC reports an account's state as of the end of a slot,
 * so two reports for one slot are the same state, and rewriting it is a no-op.
 *
 * `keep` names the columns that come from transactions rather than from the account —
 * the signatures (T048). A census reads accounts only and has no signature to give, so
 * for these a `null` coming in leaves the stored value alone instead of erasing it.
 * State columns never go in `keep`: for them `null` is a value (`revoked_at` unset).
 */
export const upsertNewer = async <T extends AccountTable>(
  db: Db,
  table: T,
  rows: T['$inferInsert'][],
  { keep = [] }: { keep?: readonly PgColumn[] } = {},
): Promise<void> => {
  if (rows.length === 0) return
  const columns = getTableColumns(table)
  // Every column but the key takes the incoming value. Built from the table rather
  // than listed, so a column added later cannot be forgotten here. The cast is only
  // what `fromEntries` cannot prove: the keys are the table's own field names.
  const set = Object.fromEntries(
    Object.entries(columns)
      .filter(([, column]) => column.primary === false)
      .map(([field, column]) => [
        field,
        keep.includes(column)
          ? sql.raw(
              `coalesce(excluded."${column.name}", "${getTableName(table)}"."${column.name}")`,
            )
          : sql.raw(`excluded."${column.name}"`),
      ]),
  ) as PgUpdateSetSource<T>
  await db
    .insert(table)
    .values(rows)
    .onConflictDoUpdate({
      target: table.address,
      set,
      setWhere: sql`${table.updatedSlot} <= excluded.updated_slot`,
    })
}
