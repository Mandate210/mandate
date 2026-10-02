// `GET /protocols/:protocol/declarations` (T050, FR-029): every entry of a protocol's
// declaration — in force, pending, expired and revoked alike — with its state at `as_of`.
// The revoked ones stay: an operation performed while an entry was in force stays
// declared after its revocation (FR-032), and a reader checking an old incident needs
// the entry as it stood then.

import { type Db, schema } from '@mandate/db'
import type { DeclarationsResponse } from '@mandate/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { fail, notIndexedYet } from '../errors'
import { withSnapshot } from '../snapshot'
import { toDeclarationEntry } from '../views'
import { protocolParam } from './params'

export const declarationRoutes = (db: Db) =>
  new Hono().get('/protocols/:protocol/declarations', protocolParam, async (c) => {
    const { protocol: address } = c.req.valid('param')
    const body = await withSnapshot(
      db,
      async ({ tx, asOf }): Promise<DeclarationsResponse | 'missing'> => {
        const [[protocol], entries] = await Promise.all([
          tx.select().from(schema.protocols).where(eq(schema.protocols.address, address)),
          tx.select().from(schema.declarations).where(eq(schema.declarations.protocol, address)),
        ])
        if (protocol === undefined) return 'missing'
        return {
          as_of: asOf,
          protocol: address,
          // Unpaged: every entry is an account the protocol pays rent for, so the list is
          // bounded by what the protocol is willing to keep on chain.
          entries: entries
            .sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)))
            .map((row) => toDeclarationEntry(row, asOf.unix_ts)),
        }
      },
    )
    if (body === null) return notIndexedYet(c)
    if (body === 'missing') return fail(c, 404, 'NOT_FOUND', 'No such protocol', { address })
    return c.json(body)
  })
