// Covered protocols registered while the attestor runs (T079).
//
// Before T079 the list of privileged addresses was read once at startup, so a protocol
// registered afterwards had no watcher until somebody restarted every attestor — cover
// that existed on chain and nowhere else. This module keeps the watcher's list in step
// with the registry, the same way `watch.ts` keeps up with transactions: **the
// subscription is the fast path, the rescan is the guarantee.** A program-account
// subscription filtered to `Protocol` reports a registration within a slot or two and
// costs no RPC credits; a dropped notification is made up by the next full read of the
// registry, which is one `getProgramAccounts` per interval.
//
// Only additions. `Protocol.privileged` is set by `register_protocol` and no instruction
// changes it, so there is nothing to stop watching.

import type { WatchedAddress, Watcher } from './watch'

/** The two ways of learning about protocols, behind a surface a test can fake. */
export interface ProtocolSource {
  /** Every privileged address of every registered protocol. */
  list(): Promise<WatchedAddress[]>
  /**
   * Calls `handler` with a protocol's privileged addresses whenever its account is
   * created or changes, and returns how to stop. A change to a protocol already watched
   * repeats addresses the watcher ignores.
   */
  subscribe(handler: (entries: WatchedAddress[]) => void): Promise<() => Promise<void>>
}

export interface ProtocolLogger {
  info(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

/**
 * Seconds between full reads of the registry. The reconcile interval of `watch.ts`, and
 * for the same reason: it bounds what a lost notification can cost. It also has to stay
 * under the watcher's startup lookback — a protocol found by the rescan is read back
 * that far, and registration can be at most one interval ago.
 */
export const DEFAULT_PROTOCOL_RESCAN_SECONDS = 600

export interface ProtocolTracker {
  /**
   * Subscribes, reads the registry once, then rescans on the interval. Run it before the
   * watcher starts and that first read is the watcher's starting list.
   */
  start(): Promise<void>
  stop(): Promise<void>
  /** One full read of the registry. Public so a test can drive it; never overlaps. */
  rescan(): Promise<void>
}

export const createProtocolTracker = ({
  source,
  watcher,
  intervalSeconds = DEFAULT_PROTOCOL_RESCAN_SECONDS,
  logger,
}: {
  source: ProtocolSource
  watcher: Pick<Watcher, 'watch'>
  intervalSeconds?: number
  logger: ProtocolLogger
}): ProtocolTracker => {
  let unsubscribe: (() => Promise<void>) | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let rescanning = false

  const take = async (entries: WatchedAddress[], via: 'subscription' | 'rescan') => {
    const added = await watcher.watch(entries)
    if (added > 0) logger.info({ via, addresses: added }, 'covered protocol registered')
  }

  const rescan = async (): Promise<void> => {
    if (rescanning) return
    rescanning = true
    try {
      await take(await source.list(), 'rescan')
    } catch (error) {
      // The subscription is still up; the next interval tries again.
      logger.error({ error }, 'could not read the protocol registry')
    } finally {
      rescanning = false
    }
  }

  return {
    async start(): Promise<void> {
      unsubscribe = await source.subscribe((entries) => {
        take(entries, 'subscription').catch((error: unknown) =>
          logger.error({ error }, 'could not watch a newly registered protocol'),
        )
      })
      // After the subscription, not before: a registration landing between the two is
      // then in at least one of them. Not through `rescan`, which only logs a failure —
      // an attestor that cannot read the registry at startup has nothing to watch, and
      // saying so by exiting is what lets its supervisor restart it.
      await watcher.watch(await source.list())
      timer = setInterval(() => void rescan(), intervalSeconds * 1000)
      timer.unref()
    },

    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      await unsubscribe?.()
      unsubscribe = null
    },

    rescan,
  }
}
