// Cache rows → the public contract (T049). Pure: no database, no clock of its own.
//
// Every derived field is computed at the `as_of` the caller passes in, with the same
// functions the contract names (`@mandate/shared`), so a response can never disagree
// with itself about what moment it describes.

import type { schema } from '@mandate/db'
import {
  type IncidentSummary,
  type Policy,
  type PoolSummary,
  type ProtocolAccount,
  isInForce,
  payable,
  quorumNeeded,
  utilizationBps,
} from '@mandate/shared'

type PoolRow = typeof schema.pools.$inferSelect
type PolicyRow = typeof schema.policies.$inferSelect
type ProtocolRow = typeof schema.protocols.$inferSelect
type IncidentRow = typeof schema.incidents.$inferSelect

/** The policy columns `isInForce` reads, as bigint and numbers. */
const coverOf = (row: PolicyRow) => ({
  status: row.status,
  premiumPaid: BigInt(row.premiumPaid),
  startTs: row.startTs,
  endTs: row.endTs,
})

export const policyInForce = (row: PolicyRow, now: number): boolean => isInForce(coverOf(row), now)

export const toPolicy = (row: PolicyRow, now: number): Policy => ({
  address: row.address,
  seq: Number(row.seq),
  limit: row.limit,
  retention: row.retention,
  remaining_limit: row.remainingLimit,
  payable: payable(BigInt(row.remainingLimit), BigInt(row.retention)).toString(),
  start_ts: row.startTs,
  end_ts: row.endTs,
  premium_paid: row.premiumPaid,
  beneficiary: row.beneficiary,
  status: row.status,
  in_force: policyInForce(row, now),
})

/** `policies` are the pool's protocol's — all of them; the ones in force are counted here. */
export const toPoolSummary = (
  pool: PoolRow,
  policies: readonly PolicyRow[],
  now: number,
): PoolSummary => ({
  protocol: pool.protocol,
  pool: pool.address,
  total_assets: pool.totalAssets,
  total_shares: pool.totalShares,
  locked_limit: pool.lockedLimit,
  utilization_bps: utilizationBps(BigInt(pool.lockedLimit), BigInt(pool.totalAssets)),
  open_incidents: pool.openIncidents,
  policies_in_force: policies.filter((policy) => policyInForce(policy, now)).length,
})

export const toProtocol = (row: ProtocolRow): ProtocolAccount => ({
  address: row.address,
  protocol_id: row.protocolId,
  authority: row.authority,
  treasury: row.treasury,
  privileged: row.privileged,
  new_policies_paused: row.newPoliciesPaused,
  incident_count: Number(row.incidentCount),
})

/** `quorumBps` is the deployment's, from `Config` — the incident stores only its set size. */
export const toIncidentSummary = (row: IncidentRow, quorumBps: number): IncidentSummary => ({
  address: row.address,
  protocol: row.protocol,
  policy: row.policy,
  trigger_signature: row.triggerSignature,
  opener: row.opener,
  bond: row.bond,
  opened_at: row.openedAt,
  deadline: row.deadline,
  set_size: row.setSize,
  quorum_needed: quorumNeeded(row.setSize, quorumBps),
  votes_unauthorized: row.votesUnauthorized,
  votes_authorized: row.votesAuthorized,
  status: row.status,
  payout: row.payout,
  shortfall: row.shortfall,
})
