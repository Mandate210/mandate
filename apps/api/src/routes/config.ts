// `GET /config` (T053): the program's singleton, which every amount and quorum on the
// page is read against — `asset_decimals` to format a sum, `quorum_bps` and
// `attestor_count` to say how many votes decide. Promised by the contract since T046.

import type { Db } from '@mandate/db'
import { Hono } from 'hono'
import { notIndexedYet } from '../errors'
import { withSnapshot } from '../snapshot'
import { toConfig } from '../views'

export const configRoutes = (db: Db) =>
  new Hono().get('/config', async (c) => {
    const body = await withSnapshot(db, async ({ asOf, config }) => toConfig(config, asOf))
    return body === null ? notIndexedYet(c) : c.json(body)
  })
