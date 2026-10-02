import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
} from 'drizzle-orm/pg-core'

/**
 * A cache of the program's accounts, and nothing else (docs/PLAN.md → «Postgres —
 * кеш»). Decided 2026-09-28 (T047):
 *
 * - **Latest state per account, plus the signatures the contract hands out.** History
 *   lives on chain; this can be dropped and rebuilt from it at any time.
 * - **No foreign keys.** The chain guarantees the relations (PDA seeds), and the
 *   indexer sees updates in no particular order — a pool can arrive before its
 *   protocol. Relations are indexed, and a missing row reads as «not indexed yet».
 * - **Nothing derived.** `state`, `in_force` and `utilization_bps` move with the clock
 *   without any write to the chain, so a stored copy would go stale; the API computes
 *   them at `as_of` with the functions in `@mandate/shared`.
 * - **One program id per database.** A redeploy under a new id (T075) means a fresh
 *   cache, not a migration.
 *
 * Every row carries `updated_slot`, and `upsertNewer` refuses to move a row back to
 * an older slot — which is what makes an indexer restart idempotent.
 */

/**
 * A `u64` from an account: `numeric(20,0)`, read and written as a decimal string —
 * the same form the API contract uses. Never `bigint`: Postgres `bigint` is signed and
 * overflows above 2^63, which a u64 reaches (CapRail lost a worker to exactly that).
 */
const u64 = (name: string) => numeric(name, { precision: 20, scale: 0 })

/** An `i64` from an account — timestamps and durations. Fits `bigint` exactly. */
const i64 = (name: string) => bigint(name, { mode: 'number' })

/** A slot. Far below 2^53 for the life of any cluster, so a JS number is exact. */
const slot = (name: string) => bigint(name, { mode: 'number' })

/** A base58 address or signature. */
const key = (name: string) => text(name)

export const policyStatus = pgEnum('policy_status', ['pending', 'active', 'expired', 'exhausted'])
export const incidentStatus = pgEnum('incident_status', ['open', 'paid_out', 'closed_no_payout'])
export const verdict = pgEnum('verdict', ['unauthorized', 'authorized'])

/** `Config`, the singleton. Its address is a PDA of the program, so it names the program too. */
export const config = pgTable('config', {
  address: key('address').primaryKey(),
  programId: key('program_id').notNull(),
  admin: key('admin').notNull(),
  assetMint: key('asset_mint').notNull(),
  /** Read from the mint, not from `Config`. */
  assetDecimals: smallint('asset_decimals').notNull(),
  declarationDelay: i64('declaration_delay').notNull(),
  attestWindow: i64('attest_window').notNull(),
  withdrawDelay: i64('withdraw_delay').notNull(),
  quorumBps: integer('quorum_bps').notNull(),
  attestorCount: integer('attestor_count').notNull(),
  openBond: u64('open_bond').notNull(),
  paused: boolean('paused').notNull(),
  updatedSlot: slot('updated_slot').notNull(),
})

export const protocols = pgTable('protocols', {
  address: key('address').primaryKey(),
  protocolId: key('protocol_id').notNull(),
  authority: key('authority').notNull(),
  treasury: key('treasury').notNull(),
  privileged: text('privileged').array().notNull(),
  pool: key('pool').notNull(),
  newPoliciesPaused: boolean('new_policies_paused').notNull(),
  nextPolicySeq: u64('next_policy_seq').notNull(),
  nextDeclarationSeq: u64('next_declaration_seq').notNull(),
  incidentCount: u64('incident_count').notNull(),
  updatedSlot: slot('updated_slot').notNull(),
})

export const pools = pgTable(
  'pools',
  {
    address: key('address').primaryKey(),
    /** Not stored on the account — it is in the PDA seeds — but every read needs it. */
    protocol: key('protocol').notNull(),
    vault: key('vault').notNull(),
    totalAssets: u64('total_assets').notNull(),
    totalShares: u64('total_shares').notNull(),
    lockedLimit: u64('locked_limit').notNull(),
    /** `u32` on chain: above `integer`'s range, inside `bigint`'s. */
    openIncidents: bigint('open_incidents', { mode: 'number' }).notNull(),
    updatedSlot: slot('updated_slot').notNull(),
  },
  (t) => [index('pools_protocol_idx').on(t.protocol)],
)

export const policies = pgTable(
  'policies',
  {
    address: key('address').primaryKey(),
    /** From the PDA seeds `["policy", protocol, seq]`, like `seq`. */
    protocol: key('protocol').notNull(),
    seq: u64('seq').notNull(),
    limit: u64('limit').notNull(),
    retention: u64('retention').notNull(),
    remainingLimit: u64('remaining_limit').notNull(),
    startTs: i64('start_ts').notNull(),
    endTs: i64('end_ts').notNull(),
    premiumPaid: u64('premium_paid').notNull(),
    beneficiary: key('beneficiary').notNull(),
    status: policyStatus('status').notNull(),
    updatedSlot: slot('updated_slot').notNull(),
  },
  (t) => [index('policies_protocol_idx').on(t.protocol)],
)

export const declarations = pgTable(
  'declarations',
  {
    address: key('address').primaryKey(),
    protocol: key('protocol').notNull(),
    seq: u64('seq').notNull(),
    programId: key('program_id').notNull(),
    /** Sixteen lowercase hex digits, as the contract carries it. */
    ixDiscriminator: text('ix_discriminator').notNull(),
    /**
     * From the declared program's on-chain Anchor IDL, when it has one and the
     * discriminator matches an instruction in it. `null` otherwise — never typed in.
     */
    instructionName: text('instruction_name'),
    notBefore: i64('not_before').notNull(),
    notAfter: i64('not_after'),
    movesFunds: boolean('moves_funds').notNull(),
    submittedAt: i64('submitted_at').notNull(),
    effectiveAt: i64('effective_at').notNull(),
    revokedAt: i64('revoked_at'),
    updatedSlot: slot('updated_slot').notNull(),
  },
  (t) => [index('declarations_protocol_idx').on(t.protocol)],
)

export const incidents = pgTable(
  'incidents',
  {
    address: key('address').primaryKey(),
    /** From the PDA seeds `["incident", protocol, trigger_sig…]`. */
    protocol: key('protocol').notNull(),
    policy: key('policy').notNull(),
    triggerSignature: key('trigger_signature').notNull(),
    /** From the RPC, not the account: `null` until fetched, or if it is no longer served. */
    triggerSlot: slot('trigger_slot'),
    triggerBlockTime: i64('trigger_block_time'),
    opener: key('opener').notNull(),
    bond: u64('bond').notNull(),
    openedAt: i64('opened_at').notNull(),
    /** The transaction that created the account. */
    openedSignature: key('opened_signature'),
    openedEpoch: u64('opened_epoch').notNull(),
    deadline: i64('deadline').notNull(),
    setSize: integer('set_size').notNull(),
    votesUnauthorized: integer('votes_unauthorized').notNull(),
    votesAuthorized: integer('votes_authorized').notNull(),
    status: incidentStatus('status').notNull(),
    payout: u64('payout').notNull(),
    shortfall: u64('shortfall').notNull(),
    /** The transaction that set `paid_out` — the one that recorded the quorum (FR-012). */
    payoutSignature: key('payout_signature'),
    payoutAt: i64('payout_at'),
    updatedSlot: slot('updated_slot').notNull(),
  },
  (t) => [
    index('incidents_protocol_idx').on(t.protocol),
    index('incidents_status_idx').on(t.status),
    // `GET /incidents` pages newest first.
    index('incidents_opened_at_idx').on(t.openedAt),
  ],
)

export const attestations = pgTable(
  'attestations',
  {
    address: key('address').primaryKey(),
    incident: key('incident').notNull(),
    /** The attestor's authority — from the PDA seeds `["attest", incident, attestor]`. */
    attestor: key('attestor').notNull(),
    verdict: verdict('verdict').notNull(),
    submittedAt: i64('submitted_at').notNull(),
    signature: key('signature'),
    updatedSlot: slot('updated_slot').notNull(),
  },
  (t) => [index('attestations_incident_idx').on(t.incident)],
)

/**
 * Where the indexer last read the chain: `census` for the last full census, `live` for
 * the last transaction it followed. The later of the two is the API's `as_of` (T049),
 * so each carries the cluster time of its slot — what derived fields are computed at.
 * `null` only if the node could not say when the slot was produced.
 */
export const indexerCursor = pgTable('indexer_cursor', {
  id: text('id').primaryKey(),
  lastSlot: slot('last_slot').notNull(),
  lastSignature: key('last_signature'),
  blockTime: i64('block_time'),
})
