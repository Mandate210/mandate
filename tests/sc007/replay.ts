// SC-007: the decision on an incident, repeated by someone who trusts none of our systems.
//
// What a third party holds is the trail (`GET /incidents/:pubkey`) and any Solana RPC.
// The trail is read here for two things only: **where to look** (addresses and
// signatures) and **what it claims** (states, counts, amounts). Everything the decision
// rests on is read from the chain by those addresses, and every derived number is
// recomputed with the rules in `@mandate/shared` — the ones the attestors and the API
// use. The answer is the list of places where the trail and the chain disagree; an
// empty list is the decision reproduced (docs/PLAN.md → «Відтворення рішення (T056)»).
//
// Our API is one of «our systems», so nothing here believes it: an entry the trail left
// out, an attestation it invented or a payout it overstated each show up as a problem.
// The trail is not even needed to find the accounts — every one of them is derived
// from the trigger signature and the protocol — but it is what a visitor arrives with.

import { BorshCoder, type Idl, utils } from '@coral-xyz/anchor'
import {
  DRAIN_COVER_IDL,
  type JsonRpc,
  accountFieldOffset,
  findAttestation,
  findConfig,
  findDeclarationEntry,
  findIncident,
  findPolicy,
  findPool,
  findVault,
  readTransaction,
  settlementsIn,
} from '@mandate/sdk'
import {
  type DeclarationEntry,
  type EntryState,
  type IncidentDetailResponse,
  type ObservedTransaction,
  type Verdict,
  base58Decode,
  entryStateAt,
  evaluateTransaction,
  fromRpcTransaction,
  isInForce,
  payable,
  quorumNeeded,
} from '@mandate/shared'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

/** Long settled by the time anyone checks: nothing here should read a state that can roll back. */
const COMMITMENT = 'finalized'

// ── Reading the chain ─────────────────────────────────────────────────────────

// The IDL as it sits on disk — snake_case, which is what `BorshCoder` decodes with.
const idl = DRAIN_COVER_IDL as unknown as Idl
const coder = new BorshCoder(idl)

type Kind =
  | 'Config'
  | 'Protocol'
  | 'Pool'
  | 'Policy'
  | 'DeclarationEntry'
  | 'Incident'
  | 'Attestation'
type Fields = Record<string, unknown>

const accountInfoSchema = z.object({
  value: z
    .object({ owner: z.string(), data: z.tuple([z.string(), z.literal('base64')]) })
    .nullable(),
})

const programAccountsSchema = z.array(
  z.object({
    pubkey: z.string(),
    account: z.object({ owner: z.string(), data: z.tuple([z.string(), z.literal('base64')]) }),
  }),
)

const signaturesSchema = z.array(
  z.object({ signature: z.string(), slot: z.number().int(), err: z.unknown() }),
)

const tokenBalanceSchema = z.object({
  accountIndex: z.number().int(),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({ amount: z.string() }),
})

/** The part of `getTransaction` the payout check reads besides the instructions. */
const settlementSchema = z.object({
  slot: z.number().int(),
  meta: z.object({
    preTokenBalances: z.array(tokenBalanceSchema).nullish(),
    postTokenBalances: z.array(tokenBalanceSchema).nullish(),
  }),
})

const key = (value: unknown): string => (value as PublicKey).toBase58()
const int = (value: unknown): number => Number((value as { toString(): string }).toString())
const big = (value: unknown): bigint => BigInt((value as { toString(): string }).toString())
const optionalInt = (value: unknown): number | null => (value === null ? null : int(value))
/** `{ PaidOut: {} }` → `paid_out`: an enum as the API spells it. */
const variant = (value: unknown): string =>
  (Object.keys(value as object)[0] ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

const toHex = (bytes: readonly number[]): string =>
  bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')

const discriminatorOf = (kind: 'accounts' | 'instructions', name: string): number[] => {
  const list = (idl[kind] ?? []) as { name: string; discriminator: number[] }[]
  const found = list.find((item) => item.name === name)
  if (found === undefined) throw new Error(`no ${name} among the IDL's ${kind}`)
  return found.discriminator
}

const sameBytes = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/** One finding: a code a test can name, and a sentence a person can act on. */
export interface Problem {
  code:
    | 'missing-account'
    | 'foreign-account'
    | 'address'
    | 'trigger'
    | 'declaration'
    | 'verdict'
    | 'attestation'
    | 'tally'
    | 'quorum'
    | 'status'
    | 'payout'
    | 'policy'
  message: string
}

export interface Replay {
  /** The rule's verdict on the trigger, from the trigger and the declaration on chain. */
  verdict: Verdict
  /** Each entry submitted before the trigger, in its state at the trigger's block time. */
  entries: { address: string; state: EntryState }[]
  quorumNeeded: number
  /** When the attestation that completed the quorum landed; `null` if none did. */
  decidedAt: number | null
  /** What the policy could still pay when the decision was taken (FR-013, FR-033). */
  owed: bigint
  problems: Problem[]
}

/**
 * The decision on the incident `trail` describes, repeated from `rpc` alone.
 *
 * Never throws over a disagreement — that is what `problems` is for. It does throw when
 * the RPC cannot answer at all, because «could not check» is not «checked and agreed».
 */
export const replayDecision = async (
  trail: IncidentDetailResponse,
  rpc: JsonRpc,
): Promise<Replay> => {
  const problems: Problem[] = []
  const report = (code: Problem['code'], message: string): void => {
    problems.push({ code, message })
  }
  const expect = (code: Problem['code'], what: string, claimed: unknown, actual: unknown): void => {
    if (String(claimed) !== String(actual)) {
      report(code, `${what}: the trail says ${String(claimed)}, the chain says ${String(actual)}`)
    }
  }

  const { verification } = trail
  const programId = new PublicKey(verification.program_id)

  /** An account of `kind`, owned by the program — anything else is somebody's lookalike. */
  const read = async (kind: Kind, address: string): Promise<Fields | null> => {
    const response = accountInfoSchema.parse(
      await rpc('getAccountInfo', [address, { encoding: 'base64', commitment: COMMITMENT }]),
    )
    if (response.value === null) {
      report('missing-account', `${kind} ${address} does not exist`)
      return null
    }
    if (response.value.owner !== verification.program_id) {
      report('foreign-account', `${kind} ${address} is owned by ${response.value.owner}`)
      return null
    }
    const data = Buffer.from(response.value.data[0], 'base64')
    if (!sameBytes([...data.subarray(0, 8)], discriminatorOf('accounts', kind))) {
      report('foreign-account', `${address} is not a ${kind}`)
      return null
    }
    return coder.accounts.decode(kind, data) as Fields
  }

  // ── Where everything is ───────────────────────────────────────────────────

  const protocolAddress = new PublicKey(verification.accounts.protocol)
  const incidentAddress = findIncident(
    programId,
    protocolAddress,
    base58Decode(trail.incident.trigger_signature),
  ).toBase58()
  expect('address', 'incident address', verification.accounts.incident, incidentAddress)
  expect('address', 'incident in the summary', trail.incident.address, incidentAddress)
  expect(
    'address',
    'protocol in the summary',
    trail.incident.protocol,
    verification.accounts.protocol,
  )
  expect('address', 'config', verification.accounts.config, findConfig(programId).toBase58())
  const poolAddress = findPool(programId, protocolAddress).toBase58()
  expect('address', 'pool', verification.accounts.pool, poolAddress)

  const [config, protocol, pool, incident] = await Promise.all([
    read('Config', findConfig(programId).toBase58()),
    read('Protocol', protocolAddress.toBase58()),
    read('Pool', poolAddress),
    read('Incident', incidentAddress),
  ])
  if (config === null || protocol === null || pool === null || incident === null) {
    throw new Error(`cannot replay: ${problems.map((p) => p.message).join('; ')}`)
  }

  const policyAddress = key(incident.policy)
  expect('address', 'policy', verification.accounts.policy, policyAddress)
  expect('address', 'policy in the summary', trail.incident.policy, policyAddress)
  const policySeqs = Array.from({ length: int(protocol.next_policy_seq) }, (_, seq) => seq)
  if (
    !policySeqs.some(
      (seq) => findPolicy(programId, protocolAddress, seq).toBase58() === policyAddress,
    )
  ) {
    report('address', `policy ${policyAddress} is not one of the protocol's`)
  }
  expect('address', "protocol's pool", poolAddress, key(protocol.pool))
  const vault = findVault(
    new PublicKey(key(config.asset_mint)),
    new PublicKey(poolAddress),
  ).toBase58()
  expect('address', 'vault', verification.accounts.vault, vault)
  expect('address', "pool's vault", vault, key(pool.vault))

  const policy = await read('Policy', policyAddress)
  if (policy === null)
    throw new Error(`cannot replay: ${problems.map((p) => p.message).join('; ')}`)

  // ── The trigger and the declaration it was judged against ─────────────────

  const triggerSignature = utils.bytes.bs58.encode(
    Uint8Array.from(incident.trigger_sig as number[]),
  )
  expect('trigger', 'trigger signature', trail.trigger.signature, triggerSignature)
  const triggerRead = await readTransaction(rpc, triggerSignature, COMMITMENT)
  if (triggerRead.kind !== 'ok')
    throw new Error(`cannot replay: the trigger is ${triggerRead.kind}`)
  const trigger: ObservedTransaction = triggerRead.transaction
  const at = trigger.blockTime
  if (trail.trigger.block_time !== null) {
    expect('trigger', 'trigger block time', trail.trigger.block_time, at)
  }
  expect(
    'trigger',
    'declaration evaluated at',
    verification.declaration_at_trigger.evaluated_at,
    at,
  )

  // Every entry the protocol ever submitted, found by deriving its address — not by
  // trusting the trail's list, which could leave out the one entry that mattered.
  const entryAddresses = Array.from({ length: int(protocol.next_declaration_seq) }, (_, seq) =>
    findDeclarationEntry(programId, protocolAddress, seq).toBase58(),
  )
  const entryAccounts = await Promise.all(
    entryAddresses.map((address) => read('DeclarationEntry', address)),
  )
  const declared: { address: string; entry: DeclarationEntry }[] = []
  entryAccounts.forEach((fields, index) => {
    if (fields === null) return
    declared.push({
      address: entryAddresses[index] as string,
      entry: {
        programId: key(fields.program_id),
        ixDiscriminator: [...(fields.ix_discriminator as number[])],
        notBefore: int(fields.not_before),
        notAfter: optionalInt(fields.not_after),
        movesFunds: fields.moves_funds as boolean,
        submittedAt: int(fields.submitted_at),
        effectiveAt: int(fields.effective_at),
        revokedAt: optionalInt(fields.revoked_at),
      },
    })
  })
  // Revocation and narrowing only ever move forward and no entry is closed, so an entry
  // read now and evaluated at `at` is the entry as it stood at `at`. One submitted
  // after the trigger did not exist then.
  const atTrigger = declared.filter(({ entry }) => entry.submittedAt <= at)
  const entries = atTrigger.map(({ address, entry }) => ({
    address,
    state: entryStateAt(entry, at),
  }))

  const claimed = new Map(verification.declaration_at_trigger.entries.map((e) => [e.address, e]))
  for (const { address, entry } of atTrigger) {
    const said = claimed.get(address)
    if (said === undefined) {
      report('declaration', `entry ${address} existed at the trigger and the trail leaves it out`)
      continue
    }
    claimed.delete(address)
    const what = `entry ${address}`
    expect('declaration', `${what} state`, said.state, entryStateAt(entry, at))
    expect('declaration', `${what} program`, said.program_id, entry.programId)
    expect(
      'declaration',
      `${what} discriminator`,
      said.ix_discriminator,
      toHex(entry.ixDiscriminator),
    )
    expect('declaration', `${what} effective_at`, said.effective_at, entry.effectiveAt)
    expect('declaration', `${what} not_before`, said.not_before, entry.notBefore)
    expect('declaration', `${what} not_after`, said.not_after, entry.notAfter)
    expect('declaration', `${what} revoked_at`, said.revoked_at, entry.revokedAt)
  }
  for (const address of claimed.keys()) {
    report('declaration', `entry ${address} is in the trail but not on chain at the trigger`)
  }

  const verdict = evaluateTransaction({
    transaction: trigger,
    entries: atTrigger.map(({ entry }) => entry),
    privileged: (protocol.privileged as unknown[]).map(key),
  })

  // ── The attestations and the quorum ───────────────────────────────────────

  const deadline = int(incident.deadline)
  const setSize = int(incident.set_size)
  const needed = quorumNeeded(setSize, int(config.quorum_bps))
  expect('quorum', 'set size', trail.incident.set_size, setSize)
  expect('quorum', 'attestations needed', trail.incident.quorum_needed, needed)
  expect('quorum', 'deadline', trail.incident.deadline, deadline)

  const seen = new Set<string>()
  const unauthorizedAt: number[] = []
  let authorized = 0
  for (const said of trail.attestations) {
    if (seen.has(said.attestor)) report('attestation', `${said.attestor} is listed twice`)
    seen.add(said.attestor)
    const address = findAttestation(
      programId,
      new PublicKey(incidentAddress),
      new PublicKey(said.attestor),
    ).toBase58()
    expect('attestation', `attestation of ${said.attestor}`, said.attestation, address)
    const fields = await read('Attestation', address)
    if (fields === null) continue
    const verdictOnChain = variant(fields.verdict)
    const submittedAt = int(fields.submitted_at)
    expect('attestation', `verdict of ${said.attestor}`, said.verdict, verdictOnChain)
    expect('attestation', `time of ${said.attestor}`, said.submitted_at, submittedAt)
    if (submittedAt > deadline)
      report('attestation', `${said.attestor} attested after the deadline`)
    if (verdictOnChain === 'unauthorized') unauthorizedAt.push(submittedAt)
    else authorized += 1
  }
  // The incident keeps its own tally. Attestations the trail does not list show up here
  // as a count that does not add up.
  expect(
    'tally',
    'unauthorized votes listed vs tallied',
    unauthorizedAt.length,
    int(incident.votes_unauthorized),
  )
  expect('tally', 'authorized votes listed vs tallied', authorized, int(incident.votes_authorized))
  expect(
    'tally',
    'unauthorized votes',
    trail.incident.votes_unauthorized,
    int(incident.votes_unauthorized),
  )
  expect(
    'tally',
    'authorized votes',
    trail.incident.votes_authorized,
    int(incident.votes_authorized),
  )

  unauthorizedAt.sort((a, b) => a - b)
  const decidedAt = unauthorizedAt.length >= needed ? (unauthorizedAt[needed - 1] ?? null) : null

  // ── The payout ────────────────────────────────────────────────────────────

  const status = variant(incident.status)
  expect('status', 'status', trail.incident.status, status)
  expect('payout', 'payout', trail.incident.payout, big(incident.payout))
  expect('payout', 'shortfall', trail.incident.shortfall, big(incident.shortfall))

  const limit = big(policy.limit)
  const retention = big(policy.retention)
  const paidOnPolicy = await paidIncidentsOf(rpc, verification.program_id, policyAddress)
  // `remaining_limit` falls only by what was paid, so the policy's own ledger says
  // whether the list above is complete.
  const paidTotal = paidOnPolicy.reduce((sum, paid) => sum + paid.payout, 0n)
  expect(
    'policy',
    'remaining limit vs paid incidents',
    big(policy.remaining_limit),
    limit - paidTotal,
  )

  let owed = payable(limit, retention)

  if (status === 'paid_out') {
    if (verdict.status !== 'undeclared') {
      report('verdict', `paid out, but the rule finds the trigger ${verdict.status}`)
    }
    if (decidedAt === null) report('quorum', `paid out on fewer than ${needed} unauthorized votes`)

    if (trail.payout === null) {
      report('payout', 'paid out, but the trail names no payout transaction')
    } else {
      const settled = await readSettlement(rpc, trail.payout.signature)
      expect('payout', 'payout time', trail.payout.at, settled.at)
      if (decidedAt !== null && settled.at < decidedAt) {
        report('payout', 'the payout landed before the quorum did')
      }
      // The transaction has to say it paid this incident: the vote that completed the
      // quorum, through its `IncidentSettled` event (T078), or a `resolve` from before.
      const settlement = settlementsIn(programId, settled.transaction).find(
        (candidate) => candidate.incident === incidentAddress,
      )
      if (settlement?.status !== 'paid_out') {
        report('payout', `${trail.payout.signature} pays nothing of this incident`)
      } else if (settlement.payout !== null) {
        expect('payout', 'amount the settlement states', settlement.payout, big(incident.payout))
      }

      const beneficiary = key(policy.beneficiary)
      expect('payout', 'beneficiary', trail.payout.beneficiary, beneficiary)
      expect('payout', 'amount in the trail', trail.payout.amount, big(incident.payout))
      expect(
        'payout',
        'amount moved to the beneficiary',
        big(incident.payout),
        settled.received(beneficiary, key(config.asset_mint)),
      )

      // FR-013/FR-033: what the policy still owed is its limit, less what earlier
      // incidents took, less the retention; the pool pays it or records the rest.
      const earlier = paidOnPolicy
        .filter((paid) => paid.address !== incidentAddress && paid.slot < settled.slot)
        .reduce((sum, paid) => sum + paid.payout, 0n)
      owed = payable(limit - earlier, retention)

      // FR-016: in force at the moment of the decision — the transaction that paid. The
      // stored status is the one *after* it, so the one before comes from the ledger:
      // only an earlier payout can have exhausted the policy.
      const inForce = isInForce(
        {
          status: owed === 0n ? 'exhausted' : 'active',
          premiumPaid: big(policy.premium_paid),
          startTs: int(policy.start_ts),
          endTs: int(policy.end_ts),
        },
        settled.at,
      )
      if (!inForce) report('policy', 'paid out on a policy that was not in force')
      expect(
        'payout',
        'payout plus shortfall vs what the policy owed',
        big(incident.payout) + big(incident.shortfall),
        owed,
      )
    }
  } else {
    if (trail.payout !== null) report('payout', `${status}, yet the trail names a payout`)
    if (big(incident.payout) !== 0n)
      report('payout', `${status}, yet the incident records a payout`)
  }

  return { verdict, entries, quorumNeeded: needed, decidedAt, owed, problems }
}

/** Every incident on `policy` that paid, with the slot of the transaction that paid it. */
const paidIncidentsOf = async (
  rpc: JsonRpc,
  programId: string,
  policy: string,
): Promise<{ address: string; payout: bigint; slot: number }[]> => {
  const accounts = programAccountsSchema.parse(
    await rpc('getProgramAccounts', [
      programId,
      {
        encoding: 'base64',
        commitment: COMMITMENT,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: utils.bytes.bs58.encode(discriminatorOf('accounts', 'Incident')),
            },
          },
          { memcmp: { offset: accountFieldOffset('Incident', 'policy'), bytes: policy } },
        ],
      },
    ]),
  )
  const paid = accounts
    .map(({ pubkey, account }) => ({
      address: pubkey,
      fields: coder.accounts.decode('Incident', Buffer.from(account.data[0], 'base64')) as Fields,
    }))
    .filter(({ fields }) => variant(fields.status) === 'paid_out')

  // Only needed to order payouts, and only when there is more than one to order.
  if (paid.length < 2)
    return paid.map(({ address, fields }) => ({ address, payout: big(fields.payout), slot: 0 }))
  return Promise.all(
    paid.map(async ({ address, fields }) => {
      // Nothing touches a settled incident, so its newest transaction is the one that settled it.
      const signatures = signaturesSchema.parse(
        await rpc('getSignaturesForAddress', [address, { commitment: COMMITMENT }]),
      )
      const settled = signatures.find(({ err }) => err == null)
      if (settled === undefined) throw new Error(`no settling transaction for ${address}`)
      return { address, payout: big(fields.payout), slot: settled.slot }
    }),
  )
}

/** The payout transaction: when it landed, what it ran, and how much each owner received. */
const readSettlement = async (rpc: JsonRpc, signature: string) => {
  // The same request `readTransaction` makes, so a recording holds it once.
  const response = await rpc('getTransaction', [
    signature,
    { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: COMMITMENT },
  ])
  const read = fromRpcTransaction(signature, response)
  if (read.kind !== 'ok') throw new Error(`cannot replay: the payout transaction is ${read.kind}`)
  const { slot, meta } = settlementSchema.parse(response)

  const balance = (
    list: z.infer<typeof tokenBalanceSchema>[] | null | undefined,
    owner: string,
    mint: string,
  ) =>
    (list ?? [])
      .filter((entry) => entry.owner === owner && entry.mint === mint)
      .reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount.amount), 0n)

  return {
    at: read.transaction.blockTime,
    slot,
    transaction: read.transaction,
    received: (owner: string, mint: string): bigint =>
      balance(meta.postTokenBalances, owner, mint) - balance(meta.preTokenBalances, owner, mint),
  }
}
