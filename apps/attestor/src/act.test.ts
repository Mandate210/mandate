import type { DeclarationEntry, ObservedTransaction } from '@drain-cover/shared'
import { describe, expect, it } from 'vitest'
import {
  type ActChain,
  type AttestVerdict,
  type IncidentRef,
  type ProtocolState,
  createActor,
} from './act'
import type { PrivilegedTransaction } from './watch'

const PROTOCOL = 'Prot11111111111111111111111111111111111111'
const PROGRAM = 'Drai11111111111111111111111111111111111111'
const ADMIN = 'Admi33333333333333333333333333333333333333'
const STRANGER = 'Stra44444444444444444444444444444444444444'
const PAUSE = [1, 2, 3, 4, 5, 6, 7, 8]
const DRAIN = [9, 9, 9, 9, 9, 9, 9, 9]
const AT = 1_000_000

const delivered = (signature = 'sig'): PrivilegedTransaction => ({
  protocol: PROTOCOL,
  address: ADMIN,
  signature,
  slot: 1,
  source: 'stream',
})

const observed = (data: number[], signers: string[] = [ADMIN]): ObservedTransaction => ({
  signature: 'sig',
  blockTime: AT,
  signers,
  accountKeys: [ADMIN, PROGRAM],
  instructions: [{ programId: PROGRAM, data, accounts: [ADMIN], stackHeight: 1 }],
})

const pauseEntry: DeclarationEntry = {
  programId: PROGRAM,
  ixDiscriminator: PAUSE,
  notBefore: 0,
  notAfter: null,
  movesFunds: false,
  submittedAt: 0,
  effectiveAt: 0,
  revokedAt: null,
}

interface FakeOptions {
  transaction?: ObservedTransaction | null
  protocol?: ProtocolState | null
  entries?: DeclarationEntry[]
  policySeq?: number | null
  incident?: IncidentRef | null
  /** Incidents that appear only once the open has been attempted — the race. */
  incidentAfterOpen?: IncidentRef | null
  attested?: boolean
  openFails?: boolean
  attestFails?: boolean
  /** Flips `hasAttested` to true after the failed write, as the winner's would. */
  attestedAfterFailure?: boolean
}

interface Fake extends ActChain {
  readonly opened: { policySeq: number; signature: string }[]
  readonly attestations: { incidentSeq: number; verdict: AttestVerdict }[]
  readonly triggerLookups: number
}

const fake = (options: FakeOptions = {}): Fake => {
  const opened: { policySeq: number; signature: string }[] = []
  const attestations: { incidentSeq: number; verdict: AttestVerdict }[] = []
  let triggerLookups = 0
  let attemptedOpen = false
  let attested = options.attested ?? false

  return {
    get opened() {
      return opened
    },
    get attestations() {
      return attestations
    },
    get triggerLookups() {
      return triggerLookups
    },
    fetchTransaction: async () =>
      options.transaction === undefined ? observed(PAUSE) : options.transaction,
    loadProtocol: async () =>
      options.protocol === undefined ? { privileged: [ADMIN] } : options.protocol,
    loadDeclaration: async () => options.entries ?? [pauseEntry],
    findPolicyInForce: async () => (options.policySeq === undefined ? 7 : options.policySeq),
    findIncidentByTrigger: async () => {
      triggerLookups += 1
      if (attemptedOpen && options.incidentAfterOpen !== undefined) return options.incidentAfterOpen
      return options.incident ?? null
    },
    openIncident: async ({ policySeq, signature }) => {
      attemptedOpen = true
      if (options.openFails) throw new Error('account already in use')
      opened.push({ policySeq, signature })
      return 3
    },
    hasAttested: async () => attested,
    attest: async ({ incidentSeq, verdict }) => {
      if (options.attestFails) {
        if (options.attestedAfterFailure) attested = true
        throw new Error('attestation already exists')
      }
      attestations.push({ incidentSeq, verdict })
    },
  }
}

describe('createActor — deciding', () => {
  it('ignores a transaction the cluster will not serve', async () => {
    const chain = fake({ transaction: null })
    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'ignored',
      reason: 'unfetchable',
    })
    expect(chain.opened).toEqual([])
  })

  it('ignores a protocol that is no longer registered', async () => {
    // The watcher outlives a deregistration, so this arrives in normal operation.
    const chain = fake({ protocol: null })
    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'ignored',
      reason: 'unknown-protocol',
    })
  })

  it('ignores what the rule says is none of the protocol’s business', async () => {
    // The watcher deals in mentions, so what it delivers is a superset on purpose.
    const chain = fake({ transaction: observed(PAUSE, [STRANGER]), protocol: { privileged: [] } })
    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'ignored',
      reason: 'not-privileged',
    })
    expect(chain.opened).toEqual([])
  })

  it('opens nothing on a declared transaction', async () => {
    const chain = fake()
    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'ignored',
      reason: 'declared',
    })
    expect(chain.opened).toEqual([])
    expect(chain.attestations).toEqual([])
  })

  it('opens an incident and attests on an undeclared one', async () => {
    const chain = fake({ transaction: observed(DRAIN) })

    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'attested',
      verdict: 'unauthorized',
      incidentSeq: 3,
      opened: true,
    })
    expect(chain.opened).toEqual([{ policySeq: 7, signature: 'sig' }])
    expect(chain.attestations).toEqual([{ incidentSeq: 3, verdict: 'unauthorized' }])
  })

  it('judges by the declaration, not by who signed', async () => {
    // The multisig case: the privileged address could not have signed, and the rule
    // still holds the protocol to the instructions that take it.
    const chain = fake({
      transaction: {
        ...observed(DRAIN, [STRANGER]),
        accountKeys: [STRANGER, ADMIN, PROGRAM],
      },
    })

    const outcome = await createActor({ chain }).act(delivered())
    expect(outcome).toMatchObject({ kind: 'attested', verdict: 'unauthorized' })
  })
})

describe('createActor — not opening what the program would refuse', () => {
  it('does not open an incident when no policy is in force', async () => {
    // `validate_open` refuses it, and opening anyway would burn a bond and freeze
    // capital on a claim that could never pay out (FR-016).
    const chain = fake({ transaction: observed(DRAIN), policySeq: null })

    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'not-opened',
      reason: 'no-policy-in-force',
    })
    expect(chain.opened).toEqual([])
  })

  it('does not attest on a settled incident', async () => {
    const chain = fake({
      transaction: observed(DRAIN),
      incident: { seq: 2, open: false },
    })

    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'ignored',
      reason: 'incident-settled',
    })
    expect(chain.attestations).toEqual([])
  })
})

describe('createActor — several attestors racing', () => {
  it('attests on an existing incident rather than opening a second one', async () => {
    // One event, one incident. A second would freeze the pool's capital twice and put
    // two bonds at risk over one compromise.
    const chain = fake({ transaction: observed(DRAIN), incident: { seq: 2, open: true } })

    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'attested',
      verdict: 'unauthorized',
      incidentSeq: 2,
      opened: false,
    })
    expect(chain.opened).toEqual([])
  })

  it('attests on the winner when it loses the race to open', async () => {
    // The window between «no incident exists» and the open is a whole round trip wide,
    // which is exactly where the other attestors are.
    const chain = fake({
      transaction: observed(DRAIN),
      openFails: true,
      incidentAfterOpen: { seq: 5, open: true },
    })

    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'attested',
      verdict: 'unauthorized',
      incidentSeq: 5,
      opened: false,
    })
    expect(chain.opened).toEqual([])
    expect(chain.triggerLookups).toBe(2)
  })

  it('rethrows a failure to open that no incident explains', async () => {
    // A lost race leaves an incident behind. Nothing does, so the open failed for some
    // other reason and swallowing it would lose a compromise silently.
    const chain = fake({ transaction: observed(DRAIN), openFails: true })

    await expect(createActor({ chain }).act(delivered())).rejects.toThrow('account already in use')
  })
})

describe('createActor — one attestor, one attestation (FR-009)', () => {
  it('does not attest twice when the transaction is delivered again', async () => {
    // A restart sweeps back over history, so re-delivery is routine.
    const chain = fake({
      transaction: observed(DRAIN),
      incident: { seq: 2, open: true },
      attested: true,
    })

    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'already-attested',
      incidentSeq: 2,
    })
    expect(chain.attestations).toEqual([])
  })

  it('treats a rejected duplicate attestation as work already done', async () => {
    const chain = fake({
      transaction: observed(DRAIN),
      incident: { seq: 2, open: true },
      attestFails: true,
      attestedAfterFailure: true,
    })

    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'already-attested',
      incidentSeq: 2,
    })
  })

  it('rethrows an attestation failure that is not a duplicate', async () => {
    const chain = fake({
      transaction: observed(DRAIN),
      incident: { seq: 2, open: true },
      attestFails: true,
    })

    await expect(createActor({ chain }).act(delivered())).rejects.toThrow(
      'attestation already exists',
    )
  })
})

describe('createActor — voting an incident down (FR-007)', () => {
  it('attests «authorized» on an incident about a transaction it finds declared', async () => {
    // A set that can only ever say «unauthorized» cannot clear a false incident, and the
    // bond backing it would never be forfeited.
    const chain = fake({ incident: { seq: 4, open: true } })

    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'attested',
      verdict: 'authorized',
      incidentSeq: 4,
      opened: false,
    })
    expect(chain.opened).toEqual([])
  })

  it('does not vote on an incident about a transaction it never judged privileged', async () => {
    const chain = fake({
      transaction: observed(PAUSE, [STRANGER]),
      protocol: { privileged: [] },
      incident: { seq: 4, open: true },
    })

    expect(await createActor({ chain }).act(delivered())).toEqual({
      kind: 'ignored',
      reason: 'not-privileged',
    })
    expect(chain.attestations).toEqual([])
  })
})
