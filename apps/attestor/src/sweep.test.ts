import { describe, expect, it } from 'vitest'
import {
  type SweepChain,
  type SweepIncident,
  type SweepPolicy,
  createSweeper,
  decideSweepAction,
  policyInForce,
  quorumThreshold,
  summariseSweep,
} from './sweep'

const NOW = 1_000_000
const DEADLINE = NOW - 1
const QUORUM_BPS = 6_000

const incident = (overrides: Partial<SweepIncident> = {}): SweepIncident => ({
  address: 'Incident1',
  protocol: 'Protocol1',
  policy: 'Policy1',
  opener: 'Opener1',
  deadline: DEADLINE,
  setSize: 3,
  votesUnauthorized: 0,
  ...overrides,
})

const inForcePolicy = (overrides: Partial<SweepPolicy> = {}): SweepPolicy => ({
  startTs: NOW - 1_000,
  endTs: NOW + 1_000,
  premiumPaid: 4_000n,
  exhausted: false,
  beneficiary: 'Beneficiary1',
  ...overrides,
})

const decide = (incidentOverrides: Partial<SweepIncident>, policy: SweepPolicy | null, now = NOW) =>
  decideSweepAction({ incident: incident(incidentOverrides), policy, quorumBps: QUORUM_BPS, now })

describe('the quorum bar', () => {
  // The same rounding as `quorum_threshold` in the program. Rounding down would let a
  // set of three clear a 60% quorum on a single attestation.
  it('rounds the share up', () => {
    expect(quorumThreshold(3, 6_000)).toBe(2)
    expect(quorumThreshold(5, 6_000)).toBe(3)
    expect(quorumThreshold(4, 5_000)).toBe(2)
    expect(quorumThreshold(1, 6_000)).toBe(1)
  })
})

describe('a policy in force', () => {
  it('reads the period, not the stored status', () => {
    expect(policyInForce(inForcePolicy(), NOW)).toBe(true)
    expect(policyInForce(inForcePolicy({ startTs: NOW + 1 }), NOW)).toBe(false)
    // The end is exclusive, as `is_in_force` has it.
    expect(policyInForce(inForcePolicy({ endTs: NOW }), NOW)).toBe(false)
    expect(policyInForce(inForcePolicy({ endTs: NOW + 1 }), NOW)).toBe(true)
  })

  it('refuses one that was never paid for, or is exhausted', () => {
    expect(policyInForce(inForcePolicy({ premiumPaid: 0n }), NOW)).toBe(false)
    expect(policyInForce(inForcePolicy({ exhausted: true }), NOW)).toBe(false)
  })
})

describe('deciding what to do with an open incident', () => {
  it('pays out a quorum on a policy still in force', () => {
    expect(decide({ votesUnauthorized: 2 }, inForcePolicy())).toBe('resolve')
  })

  // `handle_resolve` has no deadline condition, and the attestations are already in.
  // Waiting for the window to close would turn a decided payout into a closure with
  // no payout — the hole this module exists to plug.
  it('pays out before the deadline too', () => {
    expect(decide({ votesUnauthorized: 2, deadline: NOW + 1_000 }, inForcePolicy())).toBe('resolve')
  })

  it('closes an incident the window left behind', () => {
    expect(decide({ votesUnauthorized: 0 }, inForcePolicy())).toBe('close')
    expect(decide({ votesUnauthorized: 1 }, inForcePolicy())).toBe('close')
  })

  // Nothing else can end it: `resolve` refuses a policy out of force (FR-016), so
  // without this the capital would stay reserved for good.
  it('closes a confirmed incident whose policy is no longer in force', () => {
    expect(decide({ votesUnauthorized: 3 }, inForcePolicy({ endTs: NOW - 1 }))).toBe('close')
    expect(decide({ votesUnauthorized: 3 }, null)).toBe('close')
  })

  it('waits inside the attestation window', () => {
    expect(decide({ votesUnauthorized: 1, deadline: NOW + 1 }, inForcePolicy())).toBe('wait')
  })

  // The deadline second belongs to the attestation window — the same boundary
  // `validate_attest` and `validate_close` read. Closing may only start the second
  // after, or the sweeper spends a fee to be refused once per pass.
  it('treats the deadline second as still inside the window', () => {
    expect(decide({ deadline: NOW }, inForcePolicy())).toBe('wait')
    expect(decide({ deadline: NOW - 1 }, inForcePolicy())).toBe('close')
  })

  it('waits on a lapsed policy whose window is still open', () => {
    expect(
      decide({ votesUnauthorized: 3, deadline: NOW + 1 }, inForcePolicy({ endTs: NOW - 1 })),
    ).toBe('wait')
  })
})

interface FakeOptions {
  incidents?: SweepIncident[]
  policies?: Record<string, SweepPolicy | null>
  /** Owners with no settlement account; anyone not named here has one. */
  withoutSettlementAccount?: string[]
  /** Incidents whose write throws. */
  failing?: string[]
  /** Incidents that are no longer open when the failure is diagnosed — a lost race. */
  closedByOthers?: string[]
  listFails?: boolean
}

interface Fake extends SweepChain {
  readonly calls: { action: 'resolve' | 'close'; incident: string }[]
}

const fake = (options: FakeOptions = {}): Fake => {
  const calls: { action: 'resolve' | 'close'; incident: string }[] = []
  const failing = new Set(options.failing ?? [])
  const closedByOthers = new Set(options.closedByOthers ?? [])

  const write = async (action: 'resolve' | 'close', address: string): Promise<void> => {
    calls.push({ action, incident: address })
    if (failing.has(address) || closedByOthers.has(address)) {
      throw new Error(`refused: ${address}`)
    }
  }

  return {
    get calls() {
      return calls
    },
    listOpenIncidents: async () => {
      if (options.listFails) throw new Error('rpc is down')
      return options.incidents ?? []
    },
    loadPolicy: async (policy) => options.policies?.[policy] ?? inForcePolicy(),
    quorumBps: async () => QUORUM_BPS,
    settlementAccountExists: async (owner) =>
      !(options.withoutSettlementAccount ?? []).includes(owner),
    incidentOpen: async (address) => !closedByOthers.has(address),
    resolve: async (_protocol, address) => write('resolve', address),
    closeExpired: async (_protocol, address) => write('close', address),
  }
}

const sweeper = (chain: SweepChain) => createSweeper({ chain, now: () => NOW })

describe('a sweep pass', () => {
  it('reports an empty chain without acting', async () => {
    const chain = fake()
    const report = await sweeper(chain).sweepOnce()

    expect(report.scanned).toBe(0)
    expect(chain.calls).toEqual([])
  })

  it('closes what expired and leaves what has not', async () => {
    const chain = fake({
      incidents: [
        incident({ address: 'expired' }),
        incident({ address: 'inside', deadline: NOW + 60 }),
      ],
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.closed).toEqual(['expired'])
    expect(report.waiting).toBe(1)
    expect(chain.calls).toEqual([{ action: 'close', incident: 'expired' }])
  })

  // An incident that is both at quorum and past its deadline has to reach `resolve`
  // first: a policy can lapse between two instructions, and a closure is final.
  it('pays out before it closes anything', async () => {
    const chain = fake({
      incidents: [
        incident({ address: 'expired' }),
        incident({ address: 'payable', policy: 'Policy2', votesUnauthorized: 3 }),
      ],
    })
    const report = await sweeper(chain).sweepOnce()

    expect(chain.calls).toEqual([
      { action: 'resolve', incident: 'payable' },
      { action: 'close', incident: 'expired' },
    ])
    expect(report.resolved).toEqual(['payable'])
    expect(report.closed).toEqual(['expired'])
  })

  it('takes the oldest deadline first', async () => {
    const chain = fake({
      incidents: [
        incident({ address: 'newer', deadline: NOW - 1 }),
        incident({ address: 'older', deadline: NOW - 500 }),
      ],
    })
    await sweeper(chain).sweepOnce()

    expect(chain.calls.map((call) => call.incident)).toEqual(['older', 'newer'])
  })

  // The expected way to lose: somebody else swept the same incident in the seconds
  // since the listing. That is the outcome this module wanted, not a fault.
  it('counts an incident somebody else settled as lost, not failed', async () => {
    const chain = fake({
      incidents: [incident({ address: 'taken' })],
      closedByOthers: ['taken'],
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.lost).toEqual(['taken'])
    expect(report.failed).toEqual([])
    expect(report.closed).toEqual([])
  })

  it('records a genuine failure and carries on with the rest', async () => {
    const chain = fake({
      incidents: [
        incident({ address: 'broken', deadline: NOW - 500 }),
        incident({ address: 'fine' }),
      ],
      failing: ['broken'],
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.failed.map((entry) => entry.incident)).toEqual(['broken'])
    expect(report.closed).toEqual(['fine'])
  })

  // `close_expired_incident` deserialises `opener_token` in both branches, so an
  // opener that closed its settlement account leaves an incident nobody can close.
  // Reported as a state to look at, not retried into the log every ten minutes.
  it('reports an opener with no settlement account instead of attempting it', async () => {
    const chain = fake({
      incidents: [incident({ address: 'stuck', opener: 'Gone' })],
      withoutSettlementAccount: ['Gone'],
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.blocked).toEqual([{ incident: 'stuck', reason: 'opener-token-missing' }])
    expect(chain.calls).toEqual([])
    expect(report.failed).toEqual([])
  })

  // `resolve` pays into the beneficiary's account and cannot open it. Found by running
  // the one-shot command against a live ledger, where it came back as a failure the
  // next pass would have repeated forever.
  it('reports a beneficiary with no settlement account instead of failing on it', async () => {
    const chain = fake({
      incidents: [incident({ address: 'unpayable', votesUnauthorized: 3 })],
      policies: { Policy1: inForcePolicy({ beneficiary: 'NoAccount' }) },
      withoutSettlementAccount: ['NoAccount'],
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.blocked).toEqual([{ incident: 'unpayable', reason: 'beneficiary-token-missing' }])
    expect(chain.calls).toEqual([])
  })

  // A closure pays nobody but the opener, so a missing beneficiary account must not
  // hold up the incident that the window already left behind.
  it('closes an expired incident whose beneficiary has no account', async () => {
    const chain = fake({
      incidents: [incident({ address: 'expired' })],
      policies: { Policy1: inForcePolicy({ beneficiary: 'NoAccount' }) },
      withoutSettlementAccount: ['NoAccount'],
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.closed).toEqual(['expired'])
    expect(report.blocked).toEqual([])
  })

  it('judges each incident against its own policy', async () => {
    const chain = fake({
      incidents: [
        incident({ address: 'lapsed', policy: 'Lapsed', votesUnauthorized: 3 }),
        incident({ address: 'live', policy: 'Live', votesUnauthorized: 3 }),
      ],
      policies: { Lapsed: inForcePolicy({ endTs: NOW - 1 }), Live: inForcePolicy() },
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.resolved).toEqual(['live'])
    expect(report.closed).toEqual(['lapsed'])
  })

  it('lets a broken listing surface to the caller', async () => {
    await expect(sweeper(fake({ listFails: true })).sweepOnce()).rejects.toThrow('rpc is down')
  })

  // The guard has to release even when a pass throws, or one bad listing wedges the
  // sweeper for the life of the process.
  it('sweeps again after a pass that threw', async () => {
    let fails = true
    const chain: SweepChain = {
      ...fake({ incidents: [incident()] }),
      listOpenIncidents: async () => {
        if (fails) {
          fails = false
          throw new Error('rpc is down')
        }
        return [incident()]
      },
    }
    const worker = sweeper(chain)

    await expect(worker.sweepOnce()).rejects.toThrow('rpc is down')
    expect((await worker.sweepOnce()).closed).toEqual(['Incident1'])
  })
})

describe('the summary line', () => {
  it('states what a pass did', async () => {
    const report = await sweeper(fake({ incidents: [incident()] })).sweepOnce()

    expect(summariseSweep(report)).toBe(
      'scanned 1 · resolved 0 · closed 1 · waiting 0 · lost 0 · blocked 0 · failed 0',
    )
  })
})
