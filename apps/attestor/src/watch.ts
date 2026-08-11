// Watching the privileged addresses of covered protocols (R-7).
//
// This module answers exactly one question — *which transactions does this
// attestor have to look at?* — and answers it without deciding anything about
// them. The verdict is `packages/shared`'s job (T024) and acting on it is
// `act.ts`'s (T027); everything here is delivery.
//
// **The stream is the fast path, the sweep is the guarantee.** A log
// subscription is what makes SC-001 reachable (≤30 s from confirmation to
// payout, p95), but no RPC provider promises to deliver every notification, and
// a socket that dies quietly looks exactly like a protocol having a quiet
// hour. So nothing in this module trusts the socket: the cursor that says "history
// examined up to here" is advanced **only by a sweep**, which reads the address's
// signature history and is complete by construction. A notification the socket
// dropped is picked up by the next sweep instead of being lost forever, which is
// the whole of R-7 — a reconnect is only one of the ways an attestor goes blind.
//
// **Watched by mention, not by signature.** The fixtures behind SC-002 found that
// most privileged addresses never sign anything: a modern program's upgrade
// authority is usually a multisig PDA, which cannot sign, so the members sign and
// the privileged address sits in the account list (`docs/PLAN.md` → «Фікстури
// SC-002»). Both paths here are therefore mention-based — `logsSubscribe` with a
// `mentions` filter and `getSignaturesForAddress`, which index an address wherever
// it appears. That makes what this module emits a *superset* of the protocol's
// business, on purpose: an extra transaction costs one verdict, a missing one costs
// an incident that was never opened.

import { type Connection, PublicKey } from '@solana/web3.js'

/** One privileged address of one covered protocol, as `Protocol.privileged` lists it. */
export interface WatchedAddress {
  /** The `Protocol` PDA — what says which declaration the transaction is judged against. */
  protocol: string
  address: string
}

export type TransactionSource = 'stream' | 'sweep'

export interface PrivilegedTransaction {
  protocol: string
  /**
   * The watched address that surfaced the transaction. A transaction touching two
   * privileged addresses of the same protocol is reported once, under whichever of
   * them surfaced it first — it is one operation and it gets one verdict.
   */
  address: string
  signature: string
  slot: number
  source: TransactionSource
}

/** `ConfirmedSignatureInfo`, narrowed to what this module reads. */
export interface SignatureRecord {
  signature: string
  slot: number
  /** Cluster time in seconds. Null when the RPC has no block time for the slot. */
  blockTime: number | null
  /** Non-null when the transaction failed on chain. */
  err: unknown
}

export interface SignaturePage {
  /** Stop at this signature, exclusive — the cursor from the previous sweep. */
  until?: string
  /** Continue below this signature — paging within one sweep. */
  before?: string
  limit: number
}

/**
 * The RPC surface this module uses, and nothing more.
 *
 * Narrow on purpose: it is what lets the whole watcher be tested against a fake on a
 * machine with no validator and no network, which is the rule `pnpm gate` is built on
 * (`CLAUDE.md` → «Two test suites, on purpose»). `connectionWatchRpc` adapts a real
 * `Connection` to it.
 */
export interface WatchRpc {
  subscribeMentions(
    address: string,
    handler: (event: { signature: string; err: unknown }, slot: number) => void,
  ): Promise<number>
  unsubscribeMentions(id: number): Promise<void>
  subscribeSlots(handler: (slot: number) => void): number
  unsubscribeSlots(id: number): Promise<void>
  getSignatures(address: string, page: SignaturePage): Promise<SignatureRecord[]>
}

/** pino's call shape, kept as an interface so tests need no logger at all. */
export interface WatchLogger {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

const silentLogger: WatchLogger = { info: () => {}, warn: () => {}, error: () => {} }

export interface WatchPolicy {
  /**
   * Silence from the slot subscription that counts as a dead stream. Slots are ~400 ms,
   * so 30 s is roughly seventy missed heartbeats — long enough that a hiccup does not
   * trip it, short enough that the fallback starts within one poll interval.
   */
  stallSeconds: number
  /** Sweep interval while the stream is down. `ATTESTOR_FALLBACK_POLL_SECONDS`. */
  pollSeconds: number
  /**
   * Sweep interval while the stream is healthy — the safety net under silent
   * notification loss, which a slot heartbeat cannot detect. Bounds how long a dropped
   * transaction can stay unseen; costs 15 addresses × 6/h ≈ 65k RPC calls a month
   * against the 1M budget (`docs/PLAN.md` → Helius credits).
   */
  reconcileSeconds: number
  /**
   * How far back the first sweep of a process reaches. A restart is an outage like any
   * other, and this is the window it covers. Re-emitting a transaction a previous run
   * already handled is safe: `act.ts` has to be idempotent per trigger signature anyway,
   * because several attestors race to open the same incident.
   */
  startupLookbackSeconds: number
  /** How often the policy above is evaluated. */
  tickSeconds: number
  /** Signatures per `getSignaturesForAddress` call; 1000 is the RPC maximum. */
  pageSize: number
  /**
   * Pages one address may consume in one sweep. A cursor older than the RPC's retained
   * history would otherwise walk the whole chain: the gap is capped and reported instead.
   */
  maxPages: number
  /** Signatures remembered for deduplication. Has to outlast one reconcile interval. */
  seenCapacity: number
}

export const DEFAULT_WATCH_POLICY: WatchPolicy = {
  stallSeconds: 30,
  pollSeconds: 60,
  reconcileSeconds: 600,
  startupLookbackSeconds: 900,
  tickSeconds: 5,
  pageSize: 1000,
  maxPages: 5,
  seenCapacity: 4096,
}

export type SweepReason = 'startup' | 'stalled' | 'recovered' | 'reconcile'

export interface LivenessState {
  /** Millisecond clock reading of the last slot notification. */
  lastSlotAt: number
  lastSweepAt: number
  stalled: boolean
}

/**
 * Whether a sweep is due, and whether the stream counts as stalled right now.
 *
 * Pure, and separate from the watcher, because this is the part with the reasoning in
 * it — the rest is subscriptions and paging.
 *
 * A stream that has just come back sweeps **immediately** rather than waiting for the
 * next reconcile: the gap it left is exactly what R-7 is about, and the reconnect is the
 * one moment we know a gap exists.
 */
export const sweepDue = (
  state: LivenessState,
  now: number,
  policy: Pick<WatchPolicy, 'stallSeconds' | 'pollSeconds' | 'reconcileSeconds'>,
): { reason: SweepReason | null; stalled: boolean } => {
  const stalled = now - state.lastSlotAt > policy.stallSeconds * 1000
  if (stalled) {
    const due = now - state.lastSweepAt >= policy.pollSeconds * 1000
    return { stalled, reason: due ? 'stalled' : null }
  }
  if (state.stalled) return { stalled, reason: 'recovered' }
  const due = now - state.lastSweepAt >= policy.reconcileSeconds * 1000
  return { stalled, reason: due ? 'reconcile' : null }
}

/**
 * Bounded set of the signatures already reported.
 *
 * Bounded rather than complete: a worker that runs for months cannot keep every
 * signature it has seen, and it does not have to. The set only has to span the window a
 * sweep re-reads, so eviction can only ever cost a repeat — which `act.ts` absorbs, the
 * same way it absorbs a repeat across a restart.
 */
export const createSeenSet = (capacity: number) => {
  const seen = new Set<string>()
  return {
    /** True when the key had not been seen before. */
    add(key: string): boolean {
      if (seen.has(key)) return false
      seen.add(key)
      if (seen.size > capacity) {
        const oldest = seen.values().next()
        if (!oldest.done) seen.delete(oldest.value)
      }
      return true
    },
    get size(): number {
      return seen.size
    },
  }
}

export interface Watcher {
  /** Subscribes, then sweeps the startup window. Live transactions are covered first. */
  start(): Promise<void>
  stop(): Promise<void>
  /** One pass over every watched address. Safe to call at any time; never overlaps. */
  sweep(reason: SweepReason): Promise<void>
  /** The timer body. Public so a test can drive it without waiting on real time. */
  tick(): void
  readonly stalled: boolean
}

export interface WatcherOptions {
  rpc: WatchRpc
  watched: readonly WatchedAddress[]
  /**
   * Called once per transaction, awaited during a sweep so incidents are opened in the
   * order the chain produced them.
   */
  onTransaction: (transaction: PrivilegedTransaction) => void | Promise<void>
  policy?: Partial<WatchPolicy>
  logger?: WatchLogger
  /** Milliseconds. Injected so liveness can be tested without waiting for it. */
  now?: () => number
}

interface Cursor {
  signature: string
  slot: number
}

const keyOf = (entry: WatchedAddress): string => `${entry.protocol}|${entry.address}`

export const createWatcher = ({
  rpc,
  watched,
  onTransaction,
  policy: overrides,
  logger = silentLogger,
  now = Date.now,
}: WatcherOptions): Watcher => {
  const policy: WatchPolicy = { ...DEFAULT_WATCH_POLICY, ...overrides }
  const seen = createSeenSet(policy.seenCapacity)
  const cursors = new Map<string, Cursor>()
  const logSubscriptions: number[] = []

  let slotSubscription: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let sweeping = false
  let liveness: LivenessState = { lastSlotAt: now(), lastSweepAt: 0, stalled: false }

  const emit = async (transaction: PrivilegedTransaction): Promise<void> => {
    if (!seen.add(`${transaction.protocol}|${transaction.signature}`)) return
    try {
      await onTransaction(transaction)
    } catch (error) {
      // One transaction the consumer choked on must not take the subscription down with
      // it: the next privileged transaction is the one this attestor exists for.
      logger.error(
        { signature: transaction.signature, protocol: transaction.protocol, error },
        'handler failed for a privileged transaction',
      )
    }
  }

  /**
   * Signatures for one address that the previous sweep had not examined, oldest first.
   *
   * Failed transactions are dropped here and nowhere else. A transaction that errored
   * changed nothing on chain, so opening an incident on it would be a false positive of
   * exactly the kind SC-002 measures.
   */
  const collect = async (entry: WatchedAddress): Promise<SignatureRecord[]> => {
    const cursor = cursors.get(keyOf(entry))
    const floor = cursor ? null : Math.floor(now() / 1000) - policy.startupLookbackSeconds
    const collected: SignatureRecord[] = []
    let before: string | undefined
    let reachedEnd = false
    let newest: SignatureRecord | undefined

    for (let page = 0; page < policy.maxPages; page += 1) {
      const request: SignaturePage = { limit: policy.pageSize }
      if (cursor) request.until = cursor.signature
      if (before !== undefined) request.before = before
      const batch = await rpc.getSignatures(entry.address, request)
      if (batch.length === 0) {
        reachedEnd = true
        break
      }
      // Taken before the floor is applied, so a cold start on an address whose whole
      // history predates the lookback window still leaves a cursor behind. Otherwise
      // every sweep would re-read that address from scratch, forever.
      newest ??= batch[0]

      // A record with no block time is kept rather than dropped: the floor exists to
      // stop a cold start reading the whole history, not to filter transactions.
      const withinFloor =
        floor === null
          ? batch
          : batch.filter((record) => record.blockTime == null || record.blockTime >= floor)
      collected.push(...withinFloor)

      const last = batch[batch.length - 1]
      if (withinFloor.length < batch.length || batch.length < policy.pageSize || !last) {
        reachedEnd = true
        break
      }
      before = last.signature
    }

    if (!reachedEnd) {
      logger.warn(
        { address: entry.address, protocol: entry.protocol, pages: policy.maxPages },
        'signature history longer than one sweep may read — the gap is capped, not closed',
      )
    }

    if (newest && (!cursor || newest.slot >= cursor.slot)) {
      cursors.set(keyOf(entry), { signature: newest.signature, slot: newest.slot })
    }

    return collected.filter((record) => record.err == null).reverse()
  }

  const sweep = async (reason: SweepReason): Promise<void> => {
    if (sweeping) return
    sweeping = true
    liveness = { ...liveness, lastSweepAt: now() }
    try {
      for (const entry of watched) {
        try {
          for (const record of await collect(entry)) {
            await emit({
              protocol: entry.protocol,
              address: entry.address,
              signature: record.signature,
              slot: record.slot,
              source: 'sweep',
            })
          }
        } catch (error) {
          // The cursor was not advanced, so the next sweep re-reads this address from
          // where it left off. Failing one address must not skip the rest.
          logger.error(
            { address: entry.address, protocol: entry.protocol, reason, error },
            'sweep failed for one address',
          )
        }
      }
    } finally {
      sweeping = false
    }
  }

  const tick = (): void => {
    const { reason, stalled } = sweepDue(liveness, now(), policy)
    if (stalled !== liveness.stalled) {
      logger[stalled ? 'warn' : 'info'](
        { sinceSlotMs: now() - liveness.lastSlotAt },
        stalled ? 'slot notifications stopped — falling back to polling' : 'stream recovered',
      )
    }
    liveness = { ...liveness, stalled }
    if (reason) void sweep(reason)
  }

  return {
    async start(): Promise<void> {
      // The slot subscription is the liveness signal. Nothing reads the slot numbers
      // themselves — what matters is that notifications keep arriving, which is the only
      // thing that distinguishes a dead socket from a quiet one.
      slotSubscription = rpc.subscribeSlots(() => {
        liveness = { ...liveness, lastSlotAt: now() }
      })

      for (const entry of watched) {
        const id = await rpc.subscribeMentions(entry.address, (event, slot) => {
          if (event.err != null) return
          // Deliberately not advancing the cursor: the socket may have dropped an older
          // signature, and moving the cursor past it would put it beyond the reach of
          // every future sweep. Only a sweep, which reads history in order, may advance.
          void emit({
            protocol: entry.protocol,
            address: entry.address,
            signature: event.signature,
            slot,
            source: 'stream',
          })
        })
        logSubscriptions.push(id)
      }

      liveness = { ...liveness, lastSlotAt: now() }
      logger.info({ addresses: watched.length }, 'watching privileged addresses')
      await sweep('startup')

      timer = setInterval(tick, policy.tickSeconds * 1000)
      // The worker's lifetime is decided by its caller, not by this timer.
      timer.unref()
    },

    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      for (const id of logSubscriptions.splice(0)) {
        await rpc.unsubscribeMentions(id)
      }
      if (slotSubscription !== null) {
        await rpc.unsubscribeSlots(slotSubscription)
        slotSubscription = null
      }
    },

    sweep,
    tick,

    get stalled(): boolean {
      return liveness.stalled
    },
  }
}

/**
 * A real `Connection` behind the `WatchRpc` surface.
 *
 * `mentions` takes exactly one address per subscription, which is why the watcher opens
 * one per watched address rather than one per protocol. Commitment is `confirmed`
 * throughout: SC-001 measures from confirmation, and waiting for finality would spend
 * most of that budget before the attestor had even looked.
 */
export const connectionWatchRpc = (connection: Connection): WatchRpc => ({
  subscribeMentions: (address, handler) =>
    Promise.resolve(
      connection.onLogs(
        new PublicKey(address),
        (logs, context) => handler({ signature: logs.signature, err: logs.err }, context.slot),
        'confirmed',
      ),
    ),
  unsubscribeMentions: (id) => connection.removeOnLogsListener(id),
  subscribeSlots: (handler) => connection.onSlotChange((info) => handler(info.slot)),
  unsubscribeSlots: (id) => connection.removeSlotChangeListener(id),
  getSignatures: async (address, page) => {
    const options: { until?: string; before?: string; limit: number } = { limit: page.limit }
    if (page.until !== undefined) options.until = page.until
    if (page.before !== undefined) options.before = page.before
    const records = await connection.getSignaturesForAddress(
      new PublicKey(address),
      options,
      'confirmed',
    )
    return records.map((record) => ({
      signature: record.signature,
      slot: record.slot,
      blockTime: record.blockTime ?? null,
      err: record.err,
    }))
  },
})
