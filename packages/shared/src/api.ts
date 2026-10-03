import { z } from 'zod'
import { DISCRIMINATOR_BYTES } from './declaration'

/**
 * The public API contract (FR-029, FR-030): what `api` promises and `web` reads, in
 * one place, so neither side can drift from the other (docs/PLAN.md → «API-контракти»).
 *
 * Three rules shape every schema below, all decided 2026-09-28:
 *
 * - **Only what the chain can back.** Every field is an account field, something
 *   derived from account fields by a function in this package, or a transaction
 *   signature an RPC returns. No names, labels or descriptions that we wrote: a
 *   visitor checking a page against an explorer (SC-007) must find every word there.
 *   The one human-readable field, an instruction's name, is optional and carries where
 *   it was read from.
 * - **Amounts as decimal strings of base units.** Accounts hold `u64`, and a JSON
 *   number is exact only to 2^53. The string is the account field verbatim; turning it
 *   into dollars is the reader's formatting, not the contract's.
 * - **snake_case, as the program's IDL names its fields,** so a response reads
 *   side by side with the raw account.
 *
 * Every response that reports state carries `as_of`: the slot and cluster time it was
 * read at. Derived fields (`state`, `in_force`, `utilization_bps`) are computed at that
 * moment, not at the moment someone reads the JSON.
 */

// ── Primitives ────────────────────────────────────────────────────────────────

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/

/** A 32-byte key in base58: 32 to 44 characters. */
export const pubkeySchema = z.string().min(32).max(44).regex(BASE58)

/** A transaction signature — 64 bytes in base58: 64 to 88 characters. */
export const signatureSchema = z.string().min(64).max(88).regex(BASE58)

const U64_MAX = 18_446_744_073_709_551_615n

/**
 * A `u64` in base units, as a decimal string without sign, fraction or leading zeros.
 *
 * One refinement rather than a regex followed by a range check: a refinement chained
 * after a failed format check would still run, and `BigInt` throws on what the format
 * rejected.
 */
export const amountSchema = z
  .string()
  .refine((text) => /^(0|[1-9]\d{0,19})$/.test(text) && BigInt(text) <= U64_MAX, {
    message: 'Expected a u64 in base units as a decimal string',
  })

/** Reads an amount for arithmetic. Formatting it is the caller's business. */
export const toBaseUnits = (amount: string): bigint => BigInt(amount)

/** Unix seconds, as the cluster clock gives them. */
export const unixTsSchema = z.number().int()

const countSchema = z.number().int().nonnegative()

/** Eight bytes as sixteen lowercase hex digits — how explorers show a discriminator. */
export const discriminatorHexSchema = z
  .string()
  .regex(new RegExp(`^[0-9a-f]{${DISCRIMINATOR_BYTES * 2}}$`))

/** The moment a response describes. */
export const asOfSchema = z.object({
  slot: countSchema,
  unix_ts: unixTsSchema,
})

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * `GET /config` — the deployment's `Config`, one to one. Quorum and the attestor set
 * are properties of the deployment, not of a protocol, and every incident snapshots
 * the set size it opened with (`incident.set_size`).
 */
export const configResponseSchema = z.object({
  as_of: asOfSchema,
  program_id: pubkeySchema,
  admin: pubkeySchema,
  asset_mint: pubkeySchema,
  /** Read from the mint, so amounts can be formatted without a second request. */
  asset_decimals: z.number().int().min(0).max(18),
  declaration_delay: countSchema,
  attest_window: countSchema,
  withdraw_delay: countSchema,
  quorum_bps: z.number().int().min(1).max(10_000),
  attestor_count: countSchema,
  open_bond: amountSchema,
  paused: z.boolean(),
})

// ── Health ────────────────────────────────────────────────────────────────────

/** `GET /health`. `lag_slots` is how far the index is behind the cluster tip. */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  slot: countSchema,
  lag_slots: countSchema,
})

// ── Pools and policies ────────────────────────────────────────────────────────

/** `Policy.status` as stored. Whether cover applies right now is `in_force`. */
export const policyStatusSchema = z.enum(['pending', 'active', 'expired', 'exhausted'])

export const policySchema = z.object({
  address: pubkeySchema,
  seq: countSchema,
  limit: amountSchema,
  retention: amountSchema,
  remaining_limit: amountSchema,
  /** `remaining_limit − retention`, floored at zero — `Policy::payable`. */
  payable: amountSchema,
  start_ts: unixTsSchema,
  end_ts: unixTsSchema,
  premium_paid: amountSchema,
  beneficiary: pubkeySchema,
  status: policyStatusSchema,
  /** `Policy::is_in_force` at `as_of`: start inclusive, end exclusive. */
  in_force: z.boolean(),
})

/** One row of `GET /pools`. */
export const poolSummarySchema = z.object({
  protocol: pubkeySchema,
  pool: pubkeySchema,
  total_assets: amountSchema,
  total_shares: amountSchema,
  locked_limit: amountSchema,
  /**
   * `locked_limit / total_assets` in basis points, rounded down; 0 for an empty pool.
   * Not capped at 10 000: above it would mean the pool promised more than it holds,
   * which the program is meant to make impossible — and a cap would hide it.
   */
  utilization_bps: countSchema,
  open_incidents: countSchema,
  /** Policies in force at `as_of`. */
  policies_in_force: countSchema,
})

export const poolsResponseSchema = z.object({
  as_of: asOfSchema,
  pools: z.array(poolSummarySchema),
})

/** `Protocol`, as the program stores it. `protocol_id` is the key it was registered under. */
export const protocolSchema = z.object({
  address: pubkeySchema,
  protocol_id: pubkeySchema,
  authority: pubkeySchema,
  treasury: pubkeySchema,
  /** The addresses whose transactions the attestors watch. */
  privileged: z.array(pubkeySchema),
  new_policies_paused: z.boolean(),
  incident_count: countSchema,
})

// ── Incidents ─────────────────────────────────────────────────────────────────

export const incidentStatusSchema = z.enum(['open', 'paid_out', 'closed_no_payout'])
export const verdictSchema = z.enum(['unauthorized', 'authorized'])

export const incidentSummarySchema = z.object({
  address: pubkeySchema,
  protocol: pubkeySchema,
  policy: pubkeySchema,
  /** A claim by the opener until the attestors agree (see `Incident` in the program). */
  trigger_signature: signatureSchema,
  opener: pubkeySchema,
  bond: amountSchema,
  opened_at: unixTsSchema,
  deadline: unixTsSchema,
  /** The attestor set as it stood when the incident opened — the quorum's denominator. */
  set_size: countSchema,
  /** `ceil(set_size × quorum_bps / 10 000)`, as `resolve` computes it. */
  quorum_needed: countSchema,
  votes_unauthorized: countSchema,
  votes_authorized: countSchema,
  status: incidentStatusSchema,
  payout: amountSchema,
  shortfall: amountSchema,
})

/** `GET /pools/:protocol`. */
export const protocolDetailResponseSchema = z.object({
  as_of: asOfSchema,
  protocol: protocolSchema,
  pool: poolSummarySchema,
  /** Policies still holding a reservation: `pending` or `active` as stored. */
  policies: z.array(policySchema),
  recent_incidents: z.array(incidentSummarySchema),
})

// ── Declarations ──────────────────────────────────────────────────────────────

/** `entryStateAt` in `declaration.ts` — the same rule the attestors match by. */
export const entryStateSchema = z.enum(['pending', 'scheduled', 'effective', 'expired', 'revoked'])

export const declarationEntryResponseSchema = z.object({
  address: pubkeySchema,
  seq: countSchema,
  program_id: pubkeySchema,
  ix_discriminator: discriminatorHexSchema,
  /**
   * The instruction's name, when the declared program publishes an Anchor IDL on
   * chain and the discriminator matches one of its instructions. Nothing else fills
   * it: a name we typed in would be our claim about somebody else's program.
   */
  instruction: z.object({ name: z.string().min(1), source: z.literal('anchor-idl') }).nullable(),
  not_before: unixTsSchema,
  /** `null` is a permanent entry (FR-035). */
  not_after: unixTsSchema.nullable(),
  moves_funds: z.boolean(),
  submitted_at: unixTsSchema,
  effective_at: unixTsSchema,
  revoked_at: unixTsSchema.nullable(),
  state: entryStateSchema,
})

/** `GET /protocols/:protocol/declarations` — effective and revoked alike. */
export const declarationsResponseSchema = z.object({
  as_of: asOfSchema,
  protocol: pubkeySchema,
  entries: z.array(declarationEntryResponseSchema),
})

/** `GET /incidents` query. Values arrive as strings, hence the coercion. */
export const incidentsQuerySchema = z.object({
  protocol: pubkeySchema.optional(),
  status: incidentStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque: whatever the previous page returned as `next_cursor`. */
  cursor: z.string().min(1).max(200).optional(),
})

export const incidentsResponseSchema = z.object({
  as_of: asOfSchema,
  incidents: z.array(incidentSummarySchema),
  next_cursor: z.string().nullable(),
})

export const attestationResponseSchema = z.object({
  /** The attestor's authority — the key that signed. */
  attestor: pubkeySchema,
  /** The `Attestation` account, `["attest", incident, attestor]`. */
  attestation: pubkeySchema,
  verdict: verdictSchema,
  submitted_at: unixTsSchema,
  /** The transaction that created it. `null` only while the index has not seen it. */
  signature: signatureSchema.nullable(),
})

/**
 * What a third party needs to repeat the decision straight from an RPC, without this
 * API (SC-007): every account the decision read, and the declaration evaluated at the
 * moment the rule evaluates it — the trigger's block time.
 */
export const verificationSchema = z.object({
  program_id: pubkeySchema,
  accounts: z.object({
    config: pubkeySchema,
    protocol: pubkeySchema,
    pool: pubkeySchema,
    policy: pubkeySchema,
    incident: pubkeySchema,
    vault: pubkeySchema,
  }),
  declaration_at_trigger: z.object({
    /** The trigger's block time; `null` if the RPC no longer returns the transaction. */
    evaluated_at: unixTsSchema.nullable(),
    entries: z.array(declarationEntryResponseSchema),
  }),
})

/** `GET /incidents/:pubkey`. */
export const incidentDetailResponseSchema = z.object({
  as_of: asOfSchema,
  incident: incidentSummarySchema,
  trigger: z.object({
    signature: signatureSchema,
    slot: countSchema.nullable(),
    block_time: unixTsSchema.nullable(),
  }),
  opened: z.object({ signature: signatureSchema.nullable(), at: unixTsSchema }),
  attestations: z.array(attestationResponseSchema),
  /** Present once paid: the same transaction that recorded the quorum (FR-012). */
  payout: z
    .object({
      signature: signatureSchema,
      amount: amountSchema,
      beneficiary: pubkeySchema,
      at: unixTsSchema,
    })
    .nullable(),
  verification: verificationSchema,
})

// ── Errors ────────────────────────────────────────────────────────────────────

/** No `UNAUTHORIZED`: there is no authentication to fail (FR-030). */
export const errorCodeSchema = z.enum(['INVALID_INPUT', 'NOT_FOUND', 'RATE_LIMITED', 'INTERNAL'])

export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.unknown()).default({}),
  }),
})

// ── Derived fields ────────────────────────────────────────────────────────────
//
// Each mirrors the program, so the API does not invent a second rule for a number the
// chain already defines. Integer arithmetic on bigint throughout: these are u64.

/** `locked_limit / total_assets` in basis points, rounded down; 0 for an empty pool. */
export const utilizationBps = (lockedLimit: bigint, totalAssets: bigint): number =>
  totalAssets === 0n ? 0 : Number((lockedLimit * 10_000n) / totalAssets)

/**
 * Attestations an incident needs — `quorum_threshold` in `instructions/resolve.rs`.
 * Rounded **up**: rounding down would let a smaller share than `quorum_bps` decide.
 */
export const quorumNeeded = (setSize: number, quorumBps: number): number =>
  Math.ceil((setSize * quorumBps) / 10_000)

/** `Policy::payable`: what a claim can still pay, floored at zero (FR-013, FR-033). */
export const payable = (remainingLimit: bigint, retention: bigint): bigint =>
  remainingLimit > retention ? remainingLimit - retention : 0n

/**
 * `Policy::is_in_force` at `now`: start inclusive, end exclusive — and, as the program
 * has it, never for an exhausted policy or one whose premium was never paid. The period
 * alone is not the rule: a page that showed an exhausted policy as covering would
 * promise a payout `open_incident` refuses.
 */
export const isInForce = (
  policy: {
    status: z.infer<typeof policyStatusSchema>
    premiumPaid: bigint
    startTs: number
    endTs: number
  },
  now: number,
): boolean =>
  policy.status !== 'exhausted' &&
  policy.premiumPaid > 0n &&
  now >= policy.startTs &&
  now < policy.endTs

// ── Types ─────────────────────────────────────────────────────────────────────

export type AsOf = z.infer<typeof asOfSchema>
export type ConfigResponse = z.infer<typeof configResponseSchema>
export type HealthResponse = z.infer<typeof healthResponseSchema>
export type Policy = z.infer<typeof policySchema>
export type PoolSummary = z.infer<typeof poolSummarySchema>
export type PoolsResponse = z.infer<typeof poolsResponseSchema>
export type ProtocolAccount = z.infer<typeof protocolSchema>
export type IncidentSummary = z.infer<typeof incidentSummarySchema>
export type ProtocolDetailResponse = z.infer<typeof protocolDetailResponseSchema>
export type DeclarationEntryResponse = z.infer<typeof declarationEntryResponseSchema>
export type DeclarationsResponse = z.infer<typeof declarationsResponseSchema>
export type IncidentsQuery = z.infer<typeof incidentsQuerySchema>
export type IncidentsResponse = z.infer<typeof incidentsResponseSchema>
export type AttestationResponse = z.infer<typeof attestationResponseSchema>
export type Verification = z.infer<typeof verificationSchema>
export type IncidentDetailResponse = z.infer<typeof incidentDetailResponseSchema>
export type ErrorResponse = z.infer<typeof errorResponseSchema>
