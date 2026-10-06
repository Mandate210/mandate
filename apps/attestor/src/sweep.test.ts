import { describe, expect, it } from 'vitest'
import {
  type ReservedPolicy,
  type SweepChain,
  type SweepIncident,
  type SweepPolicy,
  createSweeper,
  decideSweepAction,
  policyInForce,
  policyReleasable,
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
  // The deciding vote settles an incident in the same instruction (T078), so an open
  // one at quorum on a policy in force is a state nothing reaches. Should one turn up,
  // the program refuses to close it (`IncidentPayable`) — closing it unpaid would be the
  // one wrong answer — and the sweeper does not spend a fee to be told so.
  it('leaves alone an incident at quorum on a policy in force', () => {
    expect(decide({ votesUnauthorized: 2 }, inForcePolicy())).toBe('wait')
    expect(decide({ votesUnauthorized: 2, deadline: NOW + 1_000 }, inForcePolicy())).toBe('wait')
  })

  it('closes an incident the window left behind', () => {
    expect(decide({ votesUnauthorized: 0 }, inForcePolicy())).toBe('close')
    expect(decide({ votesUnauthorized: 1 }, inForcePolicy())).toBe('close')
  })

  // A policy out of force pays nothing (FR-016); without this the capital would stay
  // reserved for good.
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

const reserved = (overrides: Partial<ReservedPolicy> = {}): ReservedPolicy => ({
  address: 'Policy1',
  protocol: 'Protocol1',
  seq: 0,
  endTs: NOW,
  ...overrides,
})

describe('releasing an expired policy', () => {
  // `validate_release`: the end is exclusive in `is_in_force`, so the end second is
  // already out of cover and already releasable — no gap, no overlap.
  it('releases from the end second on', () => {
    expect(policyReleasable(reserved({ endTs: NOW }), NOW)).toBe(true)
    expect(policyReleasable(reserved({ endTs: NOW - 1 }), NOW)).toBe(true)
    expect(policyReleasable(reserved({ endTs: NOW + 1 }), NOW)).toBe(false)
  })
})

type FakeAction = 'close' | 'release'

interface FakeOptions {
  incidents?: SweepIncident[]
  reserved?: ReservedPolicy[]
  policies?: Record<string, SweepPolicy | null>
  /** Owners with no settlement account; anyone not named here has one. */
  withoutSettlementAccount?: string[]
  /** Incidents or policies whose write throws. */
  failing?: string[]
  /**
   * Incidents no longer open, or policies no longer reserved, when the failure is
   * diagnosed — a lost race.
   */
  closedByOthers?: string[]
  listFails?: boolean
}

interface Fake extends SweepChain {
  readonly calls: { action: FakeAction; incident: string }[]
}

const fake = (options: FakeOptions = {}): Fake => {
  const calls: { action: FakeAction; incident: string }[] = []
  const failing = new Set(options.failing ?? [])
  const closedByOthers = new Set(options.closedByOthers ?? [])

  const write = async (action: FakeAction, address: string): Promise<void> => {
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
    closeExpired: async (_protocol, address) => write('close', address),
    listReservedPolicies: async () => options.reserved ?? [],
    policyReserved: async (address) => !closedByOthers.has(address),
    releaseExpiredPolicy: async (protocol, seq) => {
      const policy = (options.reserved ?? []).find(
        (candidate) => candidate.protocol === protocol && candidate.seq === seq,
      )
      await write('release', policy?.address ?? `unknown ${protocol}/${seq}`)
    },
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

  it('judges each incident against its own policy', async () => {
    const chain = fake({
      incidents: [
        incident({ address: 'lapsed', policy: 'Lapsed', votesUnauthorized: 3 }),
        incident({ address: 'live', policy: 'Live', votesUnauthorized: 3 }),
      ],
      policies: { Lapsed: inForcePolicy({ endTs: NOW - 1 }), Live: inForcePolicy() },
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.closed).toEqual(['lapsed'])
    expect(report.waiting).toBe(1)
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

describe('a sweep pass over reserved policies', () => {
  it('releases what has expired and leaves what still covers', async () => {
    const chain = fake({
      reserved: [
        reserved({ address: 'ended', seq: 0, endTs: NOW - 60 }),
        reserved({ address: 'running', seq: 1, endTs: NOW + 60 }),
      ],
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.released).toEqual(['ended'])
    expect(chain.calls).toEqual([{ action: 'release', incident: 'ended' }])
  })

  // Nothing pays past `end_ts` (FR-016), so an incident still open on the
  // policy is no reason to hold its reservation — the program agrees
  // (`validate_release`). Both happen in the same pass.
  it('releases a policy whose incident is still open', async () => {
    const chain = fake({
      incidents: [incident({ votesUnauthorized: 3, deadline: NOW + 60 })],
      policies: { Policy1: inForcePolicy({ endTs: NOW - 1 }) },
      reserved: [reserved({ endTs: NOW - 1 })],
    })
    const report = await sweeper(chain).sweepOnce()

    expect(report.waiting).toBe(1)
    expect(report.released).toEqual(['Policy1'])
  })

  it('counts a release someone else made first as lost, not failed', async () => {
    const report = await sweeper(
      fake({ reserved: [reserved()], closedByOthers: ['Policy1'] }),
    ).sweepOnce()

    expect(report.lost).toEqual(['Policy1'])
    expect(report.releaseFailed).toEqual([])
  })

  it('reports a release that failed for a reason of its own', async () => {
    const report = await sweeper(fake({ reserved: [reserved()], failing: ['Policy1'] })).sweepOnce()

    expect(report.releaseFailed.map(({ policy }) => policy)).toEqual(['Policy1'])
    expect(report.released).toEqual([])
  })
})

describe('the summary line', () => {
  it('states what a pass did', async () => {
    const report = await sweeper(
      fake({ incidents: [incident()], reserved: [reserved()] }),
    ).sweepOnce()

    expect(summariseSweep(report)).toBe(
      'scanned 1 · closed 1 · released 1 · waiting 0 · lost 0 · blocked 0 · failed 0',
    )
  })
})
