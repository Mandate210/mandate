// Accounts and transactions of the program, turned into rows of the cache (T048).
//
// Pure: no RPC, no database. `indexer.ts` fetches and writes; everything that decides
// what a row says is here, where a test can reach it with bytes it built itself.
//
// **Where each column comes from.** The account holds the state. What it does not hold
// — its place among the other accounts — sits in the seeds of its address: a `Pool`
// does not name its protocol, an `Attestation` names neither its incident nor its
// attestor, a `Protocol` does not carry the `protocol_id` it was registered under. Those
// come from one of two places, and both are the chain:
//
// - **the transaction that touched the account**, whose instruction lists them by name
//   (and whose signature is the other thing a census cannot see);
// - **derivation**: the census holds every protocol, so a policy's address can be
//   rebuilt from `["policy", protocol, seq]` for each `seq` below `next_policy_seq`, and
//   the one that matches is its parent. An address is a hash; derivation is the only
//   way back from it.
//
// A row whose parent is found by neither is not written. The schema has no foreign
// keys, and a missing row already reads as «not indexed yet» — a guessed parent would
// read as a fact.

import { BorshCoder, type Idl } from '@coral-xyz/anchor'
import { utils } from '@coral-xyz/anchor'
import type { schema } from '@mandate/db'
import {
  DRAIN_COVER_IDL,
  findAttestation,
  findConfig,
  findDeclarationEntry,
  findIncident,
  findPolicy,
  settlementsIn,
} from '@mandate/sdk'
import type { ObservedTransaction } from '@mandate/shared'
import { PublicKey } from '@solana/web3.js'

/** The account types the program owns, as the IDL names them. */
export type AccountKind =
  | 'Config'
  | 'Protocol'
  | 'Pool'
  | 'Policy'
  | 'DeclarationEntry'
  | 'Incident'
  | 'Attestation'
  | 'Attestor'
  | 'UnderwriterPosition'

type Fields = Record<string, unknown>

export type DecodedAccount = { address: string; kind: AccountKind; fields: Fields }

// The IDL as it sits on disk — snake_case. `BorshCoder` wants exactly that; the
// camelCase document the generated type describes only exists inside `Program`.
const idl = DRAIN_COVER_IDL as unknown as Idl
const coder = new BorshCoder(idl)

const discriminators = (idl.accounts ?? []).map((account) => ({
  kind: account.name as AccountKind,
  bytes: Buffer.from(account.discriminator),
}))

/**
 * The account behind these bytes, or `null` when they are not one of ours.
 *
 * `null` rather than a throw for an unknown discriminator: `getProgramAccounts` hands
 * back whatever the program owns, and an account type added by a later program
 * version should leave the rest of the census standing.
 */
export const decodeAccount = (address: string, data: Buffer): DecodedAccount | null => {
  const found = discriminators.find(({ bytes }) => data.subarray(0, 8).equals(bytes))
  if (found === undefined) return null
  return { address, kind: found.kind, fields: coder.accounts.decode(found.kind, data) as Fields }
}

// ── What a row needs besides the account ────────────────────────────────────────────

/**
 * What is known about an account's place, from wherever it was learned.
 *
 * Every field is a base58 address except `seq` (a u64 as a decimal string) and
 * `protocolId`.
 */
export type Hint = {
  protocol?: string
  seq?: string
  incident?: string
  attestor?: string
  protocolId?: string
}

export type Hints = Map<string, Hint>

/** Adds to what is known about `address`; a field already known is not overwritten. */
export const addHint = (hints: Hints, address: string, hint: Hint): void => {
  const current = hints.get(address) ?? {}
  const merged: Hint = { ...current }
  for (const [key, value] of Object.entries(hint) as [keyof Hint, string | undefined][]) {
    if (value !== undefined && merged[key] === undefined) merged[key] = value
  }
  hints.set(address, merged)
}

const key = (value: unknown): string => (value as PublicKey).toBase58()
const u64 = (value: unknown): string => (value as { toString(): string }).toString()
const i64 = (value: unknown): number => Number((value as { toString(): string }).toString())
const variant = (value: unknown): string => Object.keys(value as object)[0] ?? ''

/** `PaidOut` → `paid_out`: the enum as the database and the API spell it. */
const snake = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/**
 * Completes `hints` for every account in `accounts` that derivation can place.
 *
 * - a pool's protocol is the `Protocol` whose `pool` field names it;
 * - a policy's and a declaration's `(protocol, seq)` come from rebuilding the address
 *   for each protocol and each `seq` below that protocol's counter;
 * - an incident's protocol is its policy's (the incident names the policy) — checked by
 *   rebuilding the incident's own address from it;
 * - an attestation's `(incident, attestor)` from rebuilding the address for each pair
 *   of an incident and an attestor authority.
 *
 * `protocols`, `incidents` and `attestors` are what the caller can see beyond
 * `accounts`: a census passes everything, a single transaction passes what its rows
 * point at. Anything that stays unplaced simply keeps no hint.
 */
export const relate = (
  programId: PublicKey,
  accounts: readonly DecodedAccount[],
  hints: Hints,
  context: {
    protocols?: readonly DecodedAccount[]
    incidents?: readonly DecodedAccount[]
    attestors?: readonly string[]
  } = {},
): void => {
  const byKind = (kind: AccountKind) => accounts.filter((account) => account.kind === kind)
  const protocols = unique([...byKind('Protocol'), ...(context.protocols ?? [])])

  for (const protocol of protocols) {
    addHint(hints, key(protocol.fields.pool), { protocol: protocol.address })
  }

  const unplaced = (kind: AccountKind) =>
    new Set(
      byKind(kind)
        .filter((account) => hints.get(account.address)?.seq === undefined)
        .map((account) => account.address),
    )
  const place = (
    wanted: Set<string>,
    counter: string,
    find: (programId: PublicKey, protocol: PublicKey, seq: bigint) => PublicKey,
  ) => {
    // Newest first: a live transaction almost always touches the latest entry, so the
    // walk usually stops at its first step.
    for (const protocol of protocols) {
      if (wanted.size === 0) return
      const owner = new PublicKey(protocol.address)
      for (let seq = BigInt(u64(protocol.fields[counter])) - 1n; seq >= 0n; seq -= 1n) {
        const address = find(programId, owner, seq).toBase58()
        if (wanted.delete(address)) {
          addHint(hints, address, { protocol: protocol.address, seq: seq.toString() })
          if (wanted.size === 0) return
        }
      }
    }
  }
  place(unplaced('Policy'), 'next_policy_seq', findPolicy)
  place(unplaced('DeclarationEntry'), 'next_declaration_seq', findDeclarationEntry)

  const incidents = unique([...byKind('Incident'), ...(context.incidents ?? [])])
  for (const incident of incidents) {
    if (hints.get(incident.address)?.protocol !== undefined) continue
    const protocol = hints.get(key(incident.fields.policy))?.protocol
    if (protocol === undefined) continue
    const rebuilt = findIncident(
      programId,
      new PublicKey(protocol),
      incident.fields.trigger_sig as number[],
    )
    if (rebuilt.toBase58() === incident.address) addHint(hints, incident.address, { protocol })
  }

  const wanted = new Set(
    byKind('Attestation')
      .filter((account) => hints.get(account.address)?.incident === undefined)
      .map((account) => account.address),
  )
  const authorities = context.attestors ?? []
  for (const incident of incidents) {
    if (wanted.size === 0) break
    for (const authority of authorities) {
      const address = findAttestation(
        programId,
        new PublicKey(incident.address),
        new PublicKey(authority),
      ).toBase58()
      if (wanted.delete(address)) {
        addHint(hints, address, { incident: incident.address, attestor: authority })
      }
    }
  }
}

const unique = (accounts: readonly DecodedAccount[]): DecodedAccount[] => [
  ...new Map(accounts.map((account) => [account.address, account])).values(),
]

// ── Rows ────────────────────────────────────────────────────────────────────────────

export type Rows = {
  config: (typeof schema.config.$inferInsert)[]
  protocols: (typeof schema.protocols.$inferInsert)[]
  pools: (typeof schema.pools.$inferInsert)[]
  policies: (typeof schema.policies.$inferInsert)[]
  declarations: (typeof schema.declarations.$inferInsert)[]
  incidents: (typeof schema.incidents.$inferInsert)[]
  attestations: (typeof schema.attestations.$inferInsert)[]
}

export const emptyRows = (): Rows => ({
  config: [],
  protocols: [],
  pools: [],
  policies: [],
  declarations: [],
  incidents: [],
  attestations: [],
})

/**
 * Rows for every account that can be placed; the addresses of those that cannot.
 *
 * `slot` is the one the accounts were read at. `assetDecimals` is read from the mint by
 * the caller, since `Config` stores only the mint's address.
 */
export const toRows = (
  programId: PublicKey,
  accounts: readonly DecodedAccount[],
  hints: Hints,
  slot: number,
  assetDecimals: number | undefined,
): { rows: Rows; unplaced: string[] } => {
  const rows = emptyRows()
  const unplaced: string[] = []

  for (const { address, kind, fields } of accounts) {
    const hint = hints.get(address) ?? {}
    switch (kind) {
      case 'Config': {
        // A config somewhere other than the singleton's address is not this program's
        // config, whatever its bytes say.
        if (address !== findConfig(programId).toBase58() || assetDecimals === undefined) {
          unplaced.push(address)
          break
        }
        rows.config.push({
          address,
          programId: programId.toBase58(),
          admin: key(fields.admin),
          assetMint: key(fields.asset_mint),
          assetDecimals,
          declarationDelay: i64(fields.declaration_delay),
          attestWindow: i64(fields.attest_window),
          withdrawDelay: i64(fields.withdraw_delay),
          quorumBps: fields.quorum_bps as number,
          attestorCount: fields.attestor_count as number,
          openBond: u64(fields.open_bond),
          paused: fields.paused as boolean,
          updatedSlot: slot,
        })
        break
      }
      case 'Protocol': {
        if (hint.protocolId === undefined) {
          unplaced.push(address)
          break
        }
        rows.protocols.push({
          address,
          protocolId: hint.protocolId,
          authority: key(fields.authority),
          treasury: key(fields.treasury),
          privileged: (fields.privileged as PublicKey[]).map((entry) => entry.toBase58()),
          pool: key(fields.pool),
          newPoliciesPaused: fields.new_policies_paused as boolean,
          nextPolicySeq: u64(fields.next_policy_seq),
          nextDeclarationSeq: u64(fields.next_declaration_seq),
          incidentCount: u64(fields.incident_count),
          updatedSlot: slot,
        })
        break
      }
      case 'Pool': {
        if (hint.protocol === undefined) {
          unplaced.push(address)
          break
        }
        rows.pools.push({
          address,
          protocol: hint.protocol,
          vault: key(fields.vault),
          totalAssets: u64(fields.total_assets),
          totalShares: u64(fields.total_shares),
          lockedLimit: u64(fields.locked_limit),
          openIncidents: fields.open_incidents as number,
          updatedSlot: slot,
        })
        break
      }
      case 'Policy': {
        if (hint.protocol === undefined || hint.seq === undefined) {
          unplaced.push(address)
          break
        }
        rows.policies.push({
          address,
          protocol: hint.protocol,
          seq: hint.seq,
          limit: u64(fields.limit),
          retention: u64(fields.retention),
          remainingLimit: u64(fields.remaining_limit),
          startTs: i64(fields.start_ts),
          endTs: i64(fields.end_ts),
          premiumPaid: u64(fields.premium_paid),
          beneficiary: key(fields.beneficiary),
          status: snake(variant(fields.status)) as 'pending',
          updatedSlot: slot,
        })
        break
      }
      case 'DeclarationEntry': {
        if (hint.protocol === undefined || hint.seq === undefined) {
          unplaced.push(address)
          break
        }
        rows.declarations.push({
          address,
          protocol: hint.protocol,
          seq: hint.seq,
          programId: key(fields.program_id),
          ixDiscriminator: Buffer.from(fields.ix_discriminator as number[]).toString('hex'),
          // Filled from the declared program's own IDL, never typed in — not by this task.
          instructionName: null,
          notBefore: i64(fields.not_before),
          notAfter: fields.not_after === null ? null : i64(fields.not_after),
          movesFunds: fields.moves_funds as boolean,
          submittedAt: i64(fields.submitted_at),
          effectiveAt: i64(fields.effective_at),
          revokedAt: fields.revoked_at === null ? null : i64(fields.revoked_at),
          updatedSlot: slot,
        })
        break
      }
      case 'Incident': {
        if (hint.protocol === undefined) {
          unplaced.push(address)
          break
        }
        rows.incidents.push({
          address,
          protocol: hint.protocol,
          policy: key(fields.policy),
          triggerSignature: utils.bytes.bs58.encode(Buffer.from(fields.trigger_sig as number[])),
          triggerSlot: null,
          triggerBlockTime: null,
          opener: key(fields.opener),
          bond: u64(fields.bond),
          openedAt: i64(fields.opened_at),
          openedSignature: null,
          openedEpoch: u64(fields.opened_epoch),
          deadline: i64(fields.deadline),
          setSize: fields.set_size as number,
          votesUnauthorized: fields.votes_unauthorized as number,
          votesAuthorized: fields.votes_authorized as number,
          status: snake(variant(fields.status)) as 'open',
          payout: u64(fields.payout),
          shortfall: u64(fields.shortfall),
          payoutSignature: null,
          payoutAt: null,
          updatedSlot: slot,
        })
        break
      }
      case 'Attestation': {
        if (hint.incident === undefined || hint.attestor === undefined) {
          unplaced.push(address)
          break
        }
        rows.attestations.push({
          address,
          incident: hint.incident,
          attestor: hint.attestor,
          verdict: snake(variant(fields.verdict)) as 'unauthorized',
          submittedAt: i64(fields.submitted_at),
          signature: null,
          updatedSlot: slot,
        })
        break
      }
      // Not cached: attestors are read for derivation only, positions are an
      // underwriter's own business and no endpoint serves them.
      case 'Attestor':
      case 'UnderwriterPosition':
        break
    }
  }

  return { rows, unplaced }
}

// ── What a transaction tells ────────────────────────────────────────────────────────

/** A column that only a transaction can fill. */
export type Provenance =
  | { table: 'incidents'; address: string; openedSignature: string }
  | { table: 'incidents'; address: string; payoutSignature: string; payoutAt: number }
  | { table: 'attestations'; address: string; signature: string }

export type TransactionFacts = {
  /** Every account our instructions named — what to read back after this transaction. */
  touched: string[]
  hints: Hints
  provenance: Provenance[]
}

const instructionAccounts = new Map(
  idl.instructions.map((instruction) => [
    instruction.name,
    instruction.accounts.map((account) => account.name),
  ]),
)

/** Accounts an instruction addresses under a protocol, by the name the IDL gives them. */
const UNDER_PROTOCOL = ['pool', 'policy', 'incident', 'entry'] as const

/**
 * What a successful transaction says about the accounts it touched.
 *
 * Only this program's instructions count, top-level or reached by CPI — a multisig
 * executing `issue_policy` is still `issue_policy`. A failed transaction never gets
 * here (`toObservedTransaction` drops it): it changed nothing.
 */
export const factsFromTransaction = (
  programId: PublicKey,
  transaction: ObservedTransaction,
): TransactionFacts => {
  const facts: TransactionFacts = { touched: [], hints: new Map(), provenance: [] }
  const ours = programId.toBase58()
  const touched = new Set<string>()

  for (const instruction of transaction.instructions) {
    if (instruction.programId !== ours) continue
    const decoded = coder.instruction.decode(Buffer.from(instruction.data))
    if (decoded === null) continue
    const names = instructionAccounts.get(decoded.name) ?? []
    const named = new Map(names.map((name, index) => [name, instruction.accounts[index]]))
    const args = decoded.data as Fields
    for (const address of instruction.accounts) touched.add(address)

    const protocol = named.get('protocol')
    if (protocol !== undefined) {
      for (const name of UNDER_PROTOCOL) {
        const address = named.get(name)
        if (address !== undefined) addHint(facts.hints, address, { protocol })
      }
    }

    switch (decoded.name) {
      case 'register_protocol':
        if (protocol !== undefined) {
          addHint(facts.hints, protocol, { protocolId: key(args.protocol_id) })
        }
        break
      case 'open_incident': {
        const policy = named.get('policy')
        const incident = named.get('incident')
        if (policy !== undefined) addHint(facts.hints, policy, { seq: u64(args.policy_seq) })
        if (incident !== undefined) {
          facts.provenance.push({
            table: 'incidents',
            address: incident,
            openedSignature: transaction.signature,
          })
        }
        break
      }
      case 'release_expired_policy': {
        const policy = named.get('policy')
        if (policy !== undefined) addHint(facts.hints, policy, { seq: u64(args.policy_seq) })
        break
      }
      case 'revoke_declaration': {
        const entry = named.get('entry')
        if (entry !== undefined) addHint(facts.hints, entry, { seq: u64(args.seq) })
        break
      }
      case 'attest': {
        const attestation = named.get('attestation')
        const incident = named.get('incident')
        const authority = named.get('attestor_authority')
        if (attestation !== undefined && incident !== undefined && authority !== undefined) {
          addHint(facts.hints, attestation, { incident, attestor: authority })
          facts.provenance.push({
            table: 'attestations',
            address: attestation,
            signature: transaction.signature,
          })
        }
        break
      }
    }
  }

  // The payout is the transaction that settled the incident: since T078 the vote that
  // completed the quorum, which says so with an `IncidentSettled` event; before it, a
  // separate `resolve`. Read from the transaction, never from the incident's state
  // afterwards — votes land seconds apart, and by the time this runs a later one may
  // already have been read back as «paid».
  for (const settlement of settlementsIn(programId, transaction)) {
    touched.add(settlement.incident)
    if (settlement.status !== 'paid_out') continue
    facts.provenance.push({
      table: 'incidents',
      address: settlement.incident,
      payoutSignature: transaction.signature,
      payoutAt: transaction.blockTime,
    })
  }

  facts.touched = [...touched]
  return facts
}
