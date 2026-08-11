import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WATCH_POLICY,
  type PrivilegedTransaction,
  type SignaturePage,
  type SignatureRecord,
  type WatchRpc,
  type WatchedAddress,
  createSeenSet,
  createWatcher,
  sweepDue,
} from './watch'

const PROTOCOL = 'Pr0t0co1PDA1111111111111111111111111111111'
const ADDRESS = 'Pr1v1legedAddr11111111111111111111111111111'
const OTHER = 'Pr1v1legedAddr22222222222222222222222222222'

const watchedOne: WatchedAddress[] = [{ protocol: PROTOCOL, address: ADDRESS }]

interface Call {
  address: string
  page: SignaturePage
}

/**
 * A chain that only remembers signatures. Every test drives it directly, so nothing
 * here waits on real time, a socket or a validator.
 */
const fakeRpc = (history: Record<string, SignatureRecord[]>) => {
  const calls: Call[] = []
  const mentions = new Map<
    number,
    { address: string; handler: (event: { signature: string; err: unknown }, slot: number) => void }
  >()
  const slotHandlers = new Map<number, (slot: number) => void>()
  let nextId = 1
  let failNext = 0

  const rpc: WatchRpc = {
    subscribeMentions: (address, handler) => {
      const id = nextId++
      mentions.set(id, { address, handler })
      return Promise.resolve(id)
    },
    unsubscribeMentions: (id) => {
      mentions.delete(id)
      return Promise.resolve()
    },
    subscribeSlots: (handler) => {
      const id = nextId++
      slotHandlers.set(id, handler)
      return id
    },
    unsubscribeSlots: (id) => {
      slotHandlers.delete(id)
      return Promise.resolve()
    },
    getSignatures: async (address, page) => {
      calls.push({ address, page })
      if (failNext > 0) {
        failNext -= 1
        throw new Error('rpc down')
      }
      // Newest first, exactly as getSignaturesForAddress returns them.
      const all = history[address] ?? []
      const from = page.before ? all.findIndex((r) => r.signature === page.before) + 1 : 0
      const untilIndex = page.until ? all.findIndex((r) => r.signature === page.until) : -1
      const to = untilIndex === -1 ? all.length : untilIndex
      return all.slice(from, to).slice(0, page.limit)
    },
  }

  return {
    rpc,
    calls,
    failOnce: () => {
      failNext = 1
    },
    pushLog: (address: string, signature: string, slot: number, err: unknown = null) => {
      for (const entry of mentions.values()) {
        if (entry.address === address) entry.handler({ signature, err }, slot)
      }
    },
    pushSlot: (slot: number) => {
      for (const handler of slotHandlers.values()) handler(slot)
    },
    subscriptionCount: () => mentions.size + slotHandlers.size,
  }
}

/** Recent by default, so the startup window is not what a test is measuring. */
const record = (
  signature: string,
  slot: number,
  extra: Partial<SignatureRecord> = {},
): SignatureRecord => ({
  signature,
  slot,
  blockTime: Math.floor(Date.now() / 1000),
  err: null,
  ...extra,
})

/** Lets the sweep a tick started run to completion — it is deliberately not awaited. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const collector = () => {
  const seen: PrivilegedTransaction[] = []
  return { seen, onTransaction: (tx: PrivilegedTransaction) => void seen.push(tx) }
}

describe('sweepDue', () => {
  const policy = { stallSeconds: 30, pollSeconds: 60, reconcileSeconds: 600 }
  const now = 1_000_000

  it('does nothing while slots keep arriving and reconcile is not due', () => {
    const state = { lastSlotAt: now - 1_000, lastSweepAt: now - 10_000, stalled: false }
    expect(sweepDue(state, now, policy)).toEqual({ reason: null, stalled: false })
  })

  it('polls on the fallback interval once slot notifications stop', () => {
    const state = { lastSlotAt: now - 31_000, lastSweepAt: now - 60_000, stalled: true }
    expect(sweepDue(state, now, policy)).toEqual({ reason: 'stalled', stalled: true })
  })

  it('does not poll faster than the fallback interval', () => {
    const state = { lastSlotAt: now - 31_000, lastSweepAt: now - 30_000, stalled: true }
    expect(sweepDue(state, now, policy)).toEqual({ reason: null, stalled: true })
  })

  // R-7 in one assertion: the reconnect is the one moment a gap is known to exist, so
  // it is swept immediately instead of waiting for the next scheduled pass.
  it('sweeps immediately when the stream comes back, however recent the last sweep', () => {
    const state = { lastSlotAt: now, lastSweepAt: now - 1, stalled: true }
    expect(sweepDue(state, now, policy)).toEqual({ reason: 'recovered', stalled: false })
  })

  it('reconciles on schedule even while the stream looks healthy', () => {
    const state = { lastSlotAt: now, lastSweepAt: now - 600_000, stalled: false }
    expect(sweepDue(state, now, policy)).toEqual({ reason: 'reconcile', stalled: false })
  })
})

describe('createSeenSet', () => {
  it('reports only the first sight of a key', () => {
    const seen = createSeenSet(10)
    expect(seen.add('a')).toBe(true)
    expect(seen.add('a')).toBe(false)
  })

  it('evicts oldest first and stays at capacity', () => {
    const seen = createSeenSet(2)
    seen.add('a')
    seen.add('b')
    seen.add('c')
    expect(seen.size).toBe(2)
    expect(seen.add('a')).toBe(true)
  })
})

describe('createWatcher — the stream', () => {
  it('reports a transaction that merely mentions a privileged address', async () => {
    const chain = fakeRpc({})
    const sink = collector()
    const watcher = createWatcher({ rpc: chain.rpc, watched: watchedOne, ...sink })
    await watcher.start()

    chain.pushLog(ADDRESS, 'sig-live', 42)
    await watcher.stop()

    expect(sink.seen).toEqual([
      { protocol: PROTOCOL, address: ADDRESS, signature: 'sig-live', slot: 42, source: 'stream' },
    ])
  })

  // A failed transaction changed nothing on chain, so an incident on it is a false
  // opening of exactly the kind SC-002 measures.
  it('ignores failed transactions', async () => {
    const chain = fakeRpc({})
    const sink = collector()
    const watcher = createWatcher({ rpc: chain.rpc, watched: watchedOne, ...sink })
    await watcher.start()

    chain.pushLog(ADDRESS, 'sig-failed', 42, { InstructionError: [0, 'Custom'] })
    await watcher.stop()

    expect(sink.seen).toEqual([])
  })

  it('reports a transaction once when two privileged addresses of one protocol touch it', async () => {
    const chain = fakeRpc({})
    const sink = collector()
    const watcher = createWatcher({
      rpc: chain.rpc,
      watched: [
        { protocol: PROTOCOL, address: ADDRESS },
        { protocol: PROTOCOL, address: OTHER },
      ],
      ...sink,
    })
    await watcher.start()

    chain.pushLog(ADDRESS, 'sig-shared', 42)
    chain.pushLog(OTHER, 'sig-shared', 42)
    await watcher.stop()

    expect(sink.seen).toHaveLength(1)
  })

  it('survives a handler that throws', async () => {
    const chain = fakeRpc({})
    const seen: string[] = []
    const watcher = createWatcher({
      rpc: chain.rpc,
      watched: watchedOne,
      onTransaction: (tx) => {
        if (tx.signature === 'boom') throw new Error('handler exploded')
        seen.push(tx.signature)
      },
    })
    await watcher.start()

    chain.pushLog(ADDRESS, 'boom', 1)
    await flush()
    chain.pushLog(ADDRESS, 'sig-after', 2)
    await watcher.stop()

    expect(seen).toEqual(['sig-after'])
  })

  it('removes every subscription on stop', async () => {
    const chain = fakeRpc({})
    const watcher = createWatcher({ rpc: chain.rpc, watched: watchedOne, ...collector() })
    await watcher.start()
    expect(chain.subscriptionCount()).toBe(2)
    await watcher.stop()
    expect(chain.subscriptionCount()).toBe(0)
  })
})

describe('createWatcher — the sweep', () => {
  it('reads only the startup window on a cold start, oldest first', async () => {
    const nowSeconds = 1_000_000
    const chain = fakeRpc({
      [ADDRESS]: [
        record('recent-2', 30, { blockTime: nowSeconds - 10 }),
        record('recent-1', 20, { blockTime: nowSeconds - 20 }),
        record('ancient', 10, { blockTime: nowSeconds - 100_000 }),
      ],
    })
    const sink = collector()
    const watcher = createWatcher({
      rpc: chain.rpc,
      watched: watchedOne,
      now: () => nowSeconds * 1000,
      ...sink,
    })
    await watcher.start()
    await watcher.stop()

    expect(sink.seen.map((tx) => tx.signature)).toEqual(['recent-1', 'recent-2'])
    expect(sink.seen[0]?.source).toBe('sweep')
  })

  // The point of R-7: what the socket dropped, the sweep finds. The cursor is never
  // advanced by a stream notification, so a newer signature arriving over the socket
  // cannot put an older missed one out of the sweep's reach.
  it('picks up a signature the stream never delivered', async () => {
    const history: Record<string, SignatureRecord[]> = { [ADDRESS]: [] }
    const chain = fakeRpc(history)
    const sink = collector()
    const watcher = createWatcher({ rpc: chain.rpc, watched: watchedOne, ...sink })
    await watcher.start()

    // Two privileged transactions land; the socket delivers only the newer one.
    history[ADDRESS] = [record('sig-newer', 51), record('sig-missed', 50)]
    chain.pushLog(ADDRESS, 'sig-newer', 51)
    await watcher.sweep('recovered')
    await watcher.stop()

    expect(sink.seen.map((tx) => tx.signature)).toEqual(['sig-newer', 'sig-missed'])
    expect(sink.seen[0]?.source).toBe('stream')
    expect(sink.seen[1]?.source).toBe('sweep')
  })

  it('does not report a signature the stream already delivered', async () => {
    const chain = fakeRpc({ [ADDRESS]: [record('sig-live', 50)] })
    const sink = collector()
    const watcher = createWatcher({ rpc: chain.rpc, watched: watchedOne, ...sink })
    await watcher.start()

    chain.pushLog(ADDRESS, 'sig-live', 50)
    await watcher.sweep('reconcile')
    await watcher.stop()

    expect(sink.seen).toHaveLength(1)
  })

  it('asks only for what it has not examined once a cursor exists', async () => {
    const chain = fakeRpc({ [ADDRESS]: [record('sig-a', 50)] })
    const watcher = createWatcher({ rpc: chain.rpc, watched: watchedOne, ...collector() })
    await watcher.start()
    await watcher.sweep('reconcile')
    await watcher.stop()

    expect(chain.calls[0]?.page.until).toBeUndefined()
    expect(chain.calls[1]?.page.until).toBe('sig-a')
  })

  it('leaves a cursor even when the whole history predates the startup window', async () => {
    const nowSeconds = 1_000_000
    const chain = fakeRpc({
      [ADDRESS]: [record('ancient', 10, { blockTime: nowSeconds - 100_000 })],
    })
    const sink = collector()
    const watcher = createWatcher({
      rpc: chain.rpc,
      watched: watchedOne,
      now: () => nowSeconds * 1000,
      ...sink,
    })
    await watcher.start()
    await watcher.sweep('reconcile')
    await watcher.stop()

    expect(sink.seen).toEqual([])
    expect(chain.calls[1]?.page.until).toBe('ancient')
  })

  it('pages until it reaches the cursor', async () => {
    const history = Array.from({ length: 5 }, (_, index) => record(`sig-${5 - index}`, 50 - index))
    const chain = fakeRpc({ [ADDRESS]: history })
    const sink = collector()
    const watcher = createWatcher({
      rpc: chain.rpc,
      watched: watchedOne,
      policy: { pageSize: 2 },
      ...sink,
    })
    await watcher.start()
    await watcher.stop()

    expect(sink.seen.map((tx) => tx.signature)).toEqual([
      'sig-1',
      'sig-2',
      'sig-3',
      'sig-4',
      'sig-5',
    ])
  })

  // A cursor the RPC no longer retains would otherwise walk the chain to its genesis.
  it('caps how far one sweep may page and says so', async () => {
    const history = Array.from({ length: 20 }, (_, index) => record(`sig-${index}`, 100 - index))
    const chain = fakeRpc({ [ADDRESS]: history })
    const warnings: string[] = []
    const watcher = createWatcher({
      rpc: chain.rpc,
      watched: watchedOne,
      policy: { pageSize: 2, maxPages: 3 },
      logger: {
        info: () => {},
        warn: (_fields, message) => void warnings.push(message),
        error: () => {},
      },
      ...collector(),
    })
    await watcher.start()
    await watcher.stop()

    expect(chain.calls).toHaveLength(3)
    expect(warnings).toHaveLength(1)
  })

  // Not advancing the cursor is what makes a failed sweep harmless: the same window is
  // read again next time instead of being skipped.
  it('keeps the cursor where it was when the RPC fails, and sweeps the rest anyway', async () => {
    const chain = fakeRpc({
      [ADDRESS]: [record('sig-a', 50)],
      [OTHER]: [record('sig-b', 51)],
    })
    const sink = collector()
    const watcher = createWatcher({
      rpc: chain.rpc,
      watched: [
        { protocol: PROTOCOL, address: ADDRESS },
        { protocol: PROTOCOL, address: OTHER },
      ],
      ...sink,
    })
    chain.failOnce()
    await watcher.start()

    expect(sink.seen.map((tx) => tx.signature)).toEqual(['sig-b'])

    await watcher.sweep('reconcile')
    await watcher.stop()

    expect(sink.seen.map((tx) => tx.signature)).toEqual(['sig-b', 'sig-a'])
  })
})

describe('createWatcher — liveness', () => {
  it('falls back to polling when slot notifications stop, and recovers when they resume', async () => {
    let clock = 1_000_000
    const chain = fakeRpc({ [ADDRESS]: [record('sig-a', 50)] })
    const watcher = createWatcher({
      rpc: chain.rpc,
      watched: watchedOne,
      now: () => clock,
      ...collector(),
    })
    await watcher.start()
    const afterStart = chain.calls.length

    // Past the stall threshold *and* past one fallback interval — a stalled stream is
    // polled on the fallback schedule, not on every tick.
    clock += (DEFAULT_WATCH_POLICY.pollSeconds + 1) * 1000
    watcher.tick()
    expect(watcher.stalled).toBe(true)
    await flush()
    expect(chain.calls.length).toBeGreaterThan(afterStart)

    const afterStall = chain.calls.length
    clock += 1000
    chain.pushSlot(123)
    watcher.tick()
    await flush()

    expect(watcher.stalled).toBe(false)
    expect(chain.calls.length).toBeGreaterThan(afterStall)
    await watcher.stop()
  })

  it('stays quiet while slots keep arriving', async () => {
    let clock = 1_000_000
    const chain = fakeRpc({ [ADDRESS]: [record('sig-a', 50)] })
    const watcher = createWatcher({
      rpc: chain.rpc,
      watched: watchedOne,
      now: () => clock,
      ...collector(),
    })
    await watcher.start()
    const afterStart = chain.calls.length

    for (let step = 0; step < 10; step += 1) {
      clock += 5_000
      chain.pushSlot(step)
      watcher.tick()
    }
    await flush()

    expect(watcher.stalled).toBe(false)
    expect(chain.calls).toHaveLength(afterStart)
    await watcher.stop()
  })
})
