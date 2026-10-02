// `GET /pools` and `GET /pools/:protocol` (T049, FR-029): every pool's capital, its
// reserved limit and how loaded it is, and for one protocol the policies holding a
// reservation and its latest incidents — the same data the page shows, in JSON.

import { type Db, schema } from '@mandate/db'
import type { PoolsResponse, ProtocolDetailResponse } from '@mandate/shared'
import { asc, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { fail, notIndexedYet } from '../errors'
import { withSnapshot } from '../snapshot'
import { toIncidentSummary, toPolicy, toPoolSummary, toProtocol } from '../views'
import { protocolParam } from './params'

/** How many incidents `/pools/:protocol` carries; the rest is `/incidents?protocol=` (T051). */
export const RECENT_INCIDENTS = 20

export const poolRoutes = (db: Db) =>
  new Hono()
    .get('/pools', async (c) => {
      const body = await withSnapshot(db, async ({ tx, asOf }): Promise<PoolsResponse> => {
        const [pools, policies] = await Promise.all([
          tx.select().from(schema.pools).orderBy(asc(schema.pools.address)),
          tx.select().from(schema.policies),
        ])
        return {
          as_of: asOf,
          pools: pools.map((pool) =>
            toPoolSummary(
              pool,
              policies.filter((policy) => policy.protocol === pool.protocol),
              asOf.unix_ts,
            ),
          ),
        }
      })
      return body === null ? notIndexedYet(c) : c.json(body)
    })

    .get('/pools/:protocol', protocolParam, async (c) => {
      const { protocol: address } = c.req.valid('param')
      const body = await withSnapshot(
        db,
        async ({ tx, asOf, config }): Promise<ProtocolDetailResponse | 'missing'> => {
          const [[protocol], [pool], policies, incidents] = await Promise.all([
            tx.select().from(schema.protocols).where(eq(schema.protocols.address, address)),
            tx.select().from(schema.pools).where(eq(schema.pools.protocol, address)),
            tx.select().from(schema.policies).where(eq(schema.policies.protocol, address)),
            tx
              .select()
              .from(schema.incidents)
              .where(eq(schema.incidents.protocol, address))
              .orderBy(desc(schema.incidents.openedAt), asc(schema.incidents.address))
              .limit(RECENT_INCIDENTS),
          ])
          // No row is «not indexed yet» as much as «no such protocol»; neither has a page.
          if (protocol === undefined || pool === undefined) return 'missing'
          return {
            as_of: asOf,
            protocol: toProtocol(protocol),
            pool: toPoolSummary(pool, policies, asOf.unix_ts),
            policies: policies
              .filter((policy) => policy.status === 'pending' || policy.status === 'active')
              .sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)))
              .map((policy) => toPolicy(policy, asOf.unix_ts)),
            recent_incidents: incidents.map((row) => toIncidentSummary(row, config.quorumBps)),
          }
        },
      )
      if (body === null) return notIndexedYet(c)
      if (body === 'missing') return fail(c, 404, 'NOT_FOUND', 'No such protocol', { address })
      return c.json(body)
    })
