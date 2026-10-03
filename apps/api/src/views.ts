// Cache rows → the public contract (T049). Pure: no database, no clock of its own.
//
// Every derived field is computed at the `as_of` the caller passes in, with the same
// functions the contract names (`@mandate/shared`), so a response can never disagree
// with itself about what moment it describes.

import type { schema } from '@mandate/db'
import {
  type AttestationResponse,
  type DeclarationEntryResponse,
  type IncidentSummary,
  type Policy,
  type PoolSummary,
  type ProtocolAccount,
  type Verification,
  entryStateAt,
  isInForce,
  payable,
  quorumNeeded,
  utilizationBps,
} from '@mandate/shared'

type PoolRow = typeof schema.pools.$inferSelect
type PolicyRow = typeof schema.policies.$inferSelect
type ProtocolRow = typeof schema.protocols.$inferSelect
type IncidentRow = typeof schema.incidents.$inferSelect
type DeclarationRow = typeof schema.declarations.$inferSelect
type AttestationRow = typeof schema.attestations.$inferSelect

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

/**
 * One entry of a declaration, with its state at `now` by `entryStateAt` — the rule that
 * a test holds second by second to `entryCovers`, so «effective» here means exactly what
 * the attestors treat as declared.
 */
export const toDeclarationEntry = (row: DeclarationRow, now: number): DeclarationEntryResponse => ({
  address: row.address,
  seq: Number(row.seq),
  program_id: row.programId,
  ix_discriminator: row.ixDiscriminator,
  instruction:
    row.instructionName === null ? null : { name: row.instructionName, source: 'anchor-idl' },
  not_before: row.notBefore,
  not_after: row.notAfter,
  moves_funds: row.movesFunds,
  submitted_at: row.submittedAt,
  effective_at: row.effectiveAt,
  revoked_at: row.revokedAt,
  state: entryStateAt(
    {
      programId: row.programId,
      ixDiscriminator: [...Buffer.from(row.ixDiscriminator, 'hex')],
      notBefore: row.notBefore,
      notAfter: row.notAfter,
      movesFunds: row.movesFunds,
      submittedAt: row.submittedAt,
      effectiveAt: row.effectiveAt,
      revokedAt: row.revokedAt,
    },
    now,
  ),
})

export const toAttestation = (row: AttestationRow): AttestationResponse => ({
  attestor: row.attestor,
  attestation: row.address,
  verdict: row.verdict,
  submitted_at: row.submittedAt,
  signature: row.signature,
})

/**
 * A protocol's declaration as it stood when the trigger ran — the input the rule judged
 * the trigger against (`evaluateTransaction` takes every entry, not only the effective
 * ones), so a reader sees both what covered and why the rest did not.
 *
 * The cache holds each entry's latest state only, and that is enough: the program
 * revokes and narrows only forward (`revoke_declaration`) and closes no entry, so the
 * entry as it stands now, read at `at`, is in the state it was in at `at`. What it
 * cannot do is unsubmit — an entry submitted after the trigger did not exist then, and
 * is left out rather than shown as `pending`.
 *
 * `at` is the trigger's block time; without it there is no moment to evaluate at, and
 * the list stays empty rather than evaluated at some other one.
 */
export const toDeclarationAtTrigger = (
  rows: readonly DeclarationRow[],
  at: number | null,
): Verification['declaration_at_trigger'] => ({
  evaluated_at: at,
  entries:
    at === null
      ? []
      : rows
          .filter((row) => row.submittedAt <= at)
          .sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)))
          .map((row) => toDeclarationEntry(row, at)),
})
