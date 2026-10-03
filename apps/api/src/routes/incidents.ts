// `GET /incidents` and `GET /incidents/:pubkey` (T051, FR-011, FR-030, SC-007): the
// incidents newest first, and one incident with every attestation, the payout and
// what a third party needs to repeat the decision straight from an RPC.

import { zValidator } from '@hono/zod-validator'
import { type Db, schema } from '@mandate/db'
import {
  type IncidentDetailResponse,
  type IncidentsResponse,
  incidentsQuerySchema,
} from '@mandate/shared'
import { type SQL, and, asc, desc, eq, gt, lt, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { fail, notIndexedYet } from '../errors'
import { withSnapshot } from '../snapshot'
import { toAttestation, toDeclarationAtTrigger, toIncidentSummary } from '../views'
import { addressSchema } from './params'

/**
 * Where a page ends: the last incident's `opened_at` and address — the two keys the
 * list is ordered by. Opaque to the reader, and a key rather than an offset, so an
 * incident opened between two requests shifts nothing: it lands above the first page.
 */
type Cursor = { openedAt: number; address: string }

export const encodeCursor = ({ openedAt, address }: Cursor): string =>
  Buffer.from(`${openedAt}:${address}`).toString('base64url')

export const decodeCursor = (text: string): Cursor | null => {
  const [openedAt, address, ...rest] = Buffer.from(text, 'base64url').toString().split(':')
  if (openedAt === undefined || address === undefined || rest.length > 0) return null
  if (!/^-?\d{1,19}$/.test(openedAt) || !addressSchema.safeParse(address).success) return null
  return { openedAt: Number(openedAt), address }
}

const query = zValidator(
  'query',
  // The contract's schema, with the protocol held to 32 bytes as every path parameter is.
  incidentsQuerySchema.extend({ protocol: addressSchema.optional() }),
  (result, c) => {
    if (!result.success) {
      return fail(c, 400, 'INVALID_INPUT', 'Invalid query', { issues: result.error.issues })
    }
  },
)

const pubkeyParam = zValidator('param', z.object({ pubkey: addressSchema }), (result, c) => {
  if (!result.success) {
    return fail(c, 400, 'INVALID_INPUT', 'Invalid incident address', {
      issues: result.error.issues,
    })
  }
})

const { incidents } = schema

export const incidentRoutes = (db: Db) =>
  new Hono()
    .get('/incidents', query, async (c) => {
      const { protocol, status, limit, cursor: cursorText } = c.req.valid('query')
      const cursor = cursorText === undefined ? undefined : decodeCursor(cursorText)
      if (cursor === null) return fail(c, 400, 'INVALID_INPUT', 'Invalid cursor')

      const filters: (SQL | undefined)[] = [
        protocol === undefined ? undefined : eq(incidents.protocol, protocol),
        status === undefined ? undefined : eq(incidents.status, status),
        cursor === undefined
          ? undefined
          : or(
              lt(incidents.openedAt, cursor.openedAt),
              and(eq(incidents.openedAt, cursor.openedAt), gt(incidents.address, cursor.address)),
            ),
      ]
      const body = await withSnapshot(
        db,
        async ({ tx, asOf, config }): Promise<IncidentsResponse> => {
          // One more than the page: whether it exists is whether there is a next page.
          const rows = await tx
            .select()
            .from(incidents)
            .where(and(...filters))
            .orderBy(desc(incidents.openedAt), asc(incidents.address))
            .limit(limit + 1)
          const page = rows.slice(0, limit)
          const last = page.at(-1)
          return {
            as_of: asOf,
            incidents: page.map((row) => toIncidentSummary(row, config.quorumBps)),
            next_cursor:
              rows.length > limit && last !== undefined
                ? encodeCursor({ openedAt: last.openedAt, address: last.address })
                : null,
          }
        },
      )
      return body === null ? notIndexedYet(c) : c.json(body)
    })

    .get('/incidents/:pubkey', pubkeyParam, async (c) => {
      const { pubkey: address } = c.req.valid('param')
      const body = await withSnapshot(
        db,
        async ({ tx, asOf, config }): Promise<IncidentDetailResponse | 'missing'> => {
          const [incident] = await tx.select().from(incidents).where(eq(incidents.address, address))
          if (incident === undefined) return 'missing'

          const [[pool], [policy], attestations, entries] = await Promise.all([
            tx.select().from(schema.pools).where(eq(schema.pools.protocol, incident.protocol)),
            tx.select().from(schema.policies).where(eq(schema.policies.address, incident.policy)),
            tx
              .select()
              .from(schema.attestations)
              .where(eq(schema.attestations.incident, address))
              .orderBy(asc(schema.attestations.submittedAt), asc(schema.attestations.attestor)),
            tx
              .select()
              .from(schema.declarations)
              .where(eq(schema.declarations.protocol, incident.protocol)),
          ])
          // No account of the program is ever closed, so an indexed incident without its
          // pool or policy is one the index has only half read — not a page to serve.
          if (pool === undefined || policy === undefined) return 'missing'

          return {
            as_of: asOf,
            incident: toIncidentSummary(incident, config.quorumBps),
            trigger: {
              signature: incident.triggerSignature,
              slot: incident.triggerSlot,
              block_time: incident.triggerBlockTime,
            },
            opened: { signature: incident.openedSignature, at: incident.openedAt },
            attestations: attestations.map(toAttestation),
            // Paid, and the transaction that paid already found. Until it is, the status
            // says paid and this stays empty: a signature is not something to guess.
            payout:
              incident.status === 'paid_out' &&
              incident.payoutSignature !== null &&
              incident.payoutAt !== null
                ? {
                    signature: incident.payoutSignature,
                    amount: incident.payout,
                    beneficiary: policy.beneficiary,
                    at: incident.payoutAt,
                  }
                : null,
            verification: {
              program_id: config.programId,
              accounts: {
                config: config.address,
                protocol: incident.protocol,
                pool: pool.address,
                policy: incident.policy,
                incident: incident.address,
                vault: pool.vault,
              },
              declaration_at_trigger: toDeclarationAtTrigger(entries, incident.triggerBlockTime),
            },
          }
        },
      )
      if (body === null) return notIndexedYet(c)
      if (body === 'missing') return fail(c, 404, 'NOT_FOUND', 'No such incident', { address })
      return c.json(body)
    })
