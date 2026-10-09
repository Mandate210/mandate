import type { AttestorStatus, HealthResponse } from '@mandate/shared'
import { describe, expect, it } from 'vitest'
import { notYetWatching, protocolCounts, waitForHostedAttestors } from './hosted'

const A = 'BpZLNoQs88L4gfKx8samxUdHaZpNuRBgApcr43irUPES'
const B = 'B7sS2L32qCJZj8mRK9S99uivD5ZSn13QopZZh6dBu5Da'

const status = (attestor: string, protocols: number | null, ok = true): AttestorStatus => ({
  attestor,
  ok,
  reason: ok ? null : 'behind_tip',
  examined_slot: 100,
  lag_slots: 0,
  last_complete_sweep_at: 1_800_000_000,
  protocols,
})

const health = (...attestors: AttestorStatus[]): HealthResponse => ({
  ok: attestors.every((one) => one.ok),
  slot: 100,
  lag_slots: 0,
  attestors,
  quorum_needed: 2,
  quorum_alive: true,
})

describe('protocolCounts', () => {
  it('reads each attestor’s count by key', () => {
    expect(protocolCounts(health(status(A, 24), status(B, 23)))).toEqual(
      new Map([
        [A, 24],
        [B, 23],
      ]),
    )
  })

  // Waiting on a count nobody reports would wait out the whole timeout for nothing.
  it('refuses a deployment whose attestors predate the count', () => {
    expect(() => protocolCounts(health(status(A, 24), status(B, null)))).toThrow(/predates T079/)
  })

  it('refuses an attestor that does not answer', () => {
    const silent: AttestorStatus = {
      ...status(A, null, false),
      attestor: null,
      reason: 'unreachable',
    }
    expect(() => protocolCounts(health(silent))).toThrow(/does not answer/)
  })
})

describe('notYetWatching', () => {
  const baseline = new Map([
    [A, 24],
    [B, 23],
  ])

  it('is empty once every attestor counts the new protocols', () => {
    expect(notYetWatching(baseline, health(status(A, 26), status(B, 25)), 2)).toEqual([])
  })

  // Relative to each attestor's own baseline: one that had already missed a protocol
  // still has to take on the new ones.
  it('names an attestor that has taken on only some of them', () => {
    expect(notYetWatching(baseline, health(status(A, 26), status(B, 24)), 2)).toEqual([B])
  })

  it('names an attestor that is unwell, however many it counts', () => {
    expect(notYetWatching(baseline, health(status(A, 26), status(B, 25, false)), 2)).toEqual([B])
  })

  it('names an attestor missing from /health altogether', () => {
    expect(notYetWatching(baseline, health(status(A, 26)), 2)).toEqual([B])
  })
})

describe('waitForHostedAttestors', () => {
  const baseline = new Map([[A, 24]])

  it('returns once ready, polling through a failed read', async () => {
    let clock = 0
    const answers: (HealthResponse | Error)[] = [
      health(status(A, 24)),
      new Error('fetch failed'),
      health(status(A, 25)),
    ]
    const elapsed = await waitForHostedAttestors({
      apiUrl: 'http://api',
      baseline,
      added: 1,
      timeoutSeconds: 60,
      read: async () => {
        const next = answers.shift()
        if (next instanceof Error) throw next
        if (next === undefined) throw new Error('read past the script')
        return next
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    expect(elapsed).toBe(6)
  })

  it('gives up after the timeout and names who is still not watching', async () => {
    let clock = 0
    let reads = 0
    await expect(
      waitForHostedAttestors({
        apiUrl: 'http://api',
        baseline,
        added: 1,
        timeoutSeconds: 10,
        read: async () => {
          reads += 1
          return health(status(A, 24))
        },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
      }),
    ).rejects.toThrow(`still do not watch the 1 new protocols: ${A}`)
    // At 0, 3, 6 and 9 s it is still in time; the read at 12 s is the last.
    expect(reads).toBe(5)
  })
})
