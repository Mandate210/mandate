// The scenario against attestors it did not start (T080).
//
// Locally and in the first devnet runs the scenario started its own workers on the
// set's keys. That proves the decision path and nothing about the deployment: the
// attestors that actually guard devnet run on a server, and a run that votes in their
// place says nothing about whether they would have. `--hosted` stages the same world
// and then only fires — every vote comes from the deployment.
//
// The one thing it has to know first is that the deployment is watching what it just
// staged. A transaction fired before an attestor subscribes to the new address is still
// read back (T079), but late — and late is exactly what SC-005 measures. So it waits
// until every attestor's `/health` shows the new protocols in its count.

import { type HealthResponse, healthResponseSchema } from '@mandate/shared'

/** The deployment's public API, as `pages.yml` builds the site against it. */
export const DEFAULT_API_URL = 'https://204-168-183-173.sslip.io'

/** `/health` answers 503 with a full body when any attestor is unwell; both are reports. */
export const readHealth = async (apiUrl: string): Promise<HealthResponse> => {
  const response = await fetch(new URL('/health', apiUrl))
  return healthResponseSchema.parse(await response.json())
}

/**
 * How many protocols each attestor watches, by key. Throws when the count cannot serve
 * as a baseline: an attestor that does not answer, or one from before T079 that does
 * not report it — waiting on either would wait forever.
 */
export const protocolCounts = (health: HealthResponse): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const status of health.attestors) {
    if (status.attestor === null) {
      throw new Error(`an attestor of the deployment does not answer (${status.reason})`)
    }
    if (status.protocols == null) {
      throw new Error(
        `attestor ${status.attestor} does not report the protocols it watches — it predates T079; update the deployment first`,
      )
    }
    counts.set(status.attestor, status.protocols)
  }
  if (counts.size === 0) throw new Error('the deployment reports no attestors at all')
  return counts
}

/**
 * Which attestors are not yet watching `added` more protocols than at `baseline`, or are
 * not healthy. Empty means ready to fire. Every attestor of the baseline has to be
 * there: one that dropped out of `/health` is not watching anything.
 */
export const notYetWatching = (
  baseline: ReadonlyMap<string, number>,
  health: HealthResponse,
  added: number,
): string[] => {
  const waiting: string[] = []
  for (const [attestor, before] of baseline) {
    const status = health.attestors.find((candidate) => candidate.attestor === attestor)
    if (status === undefined || !status.ok || (status.protocols ?? 0) < before + added) {
      waiting.push(attestor)
    }
  }
  return waiting
}

/** Polls `/health` until `notYetWatching` is empty, or throws after `timeoutSeconds`. */
export const waitForHostedAttestors = async ({
  apiUrl,
  baseline,
  added,
  timeoutSeconds,
  pollSeconds = 3,
  read = readHealth,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  apiUrl: string
  baseline: ReadonlyMap<string, number>
  added: number
  timeoutSeconds: number
  pollSeconds?: number
  read?: (apiUrl: string) => Promise<HealthResponse>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<number> => {
  const started = now()
  for (;;) {
    let waiting: string[]
    try {
      waiting = notYetWatching(baseline, await read(apiUrl), added)
    } catch {
      // The API is between deploys or the network blinked; the deadline still applies.
      waiting = [...baseline.keys()]
    }
    const elapsed = (now() - started) / 1000
    if (waiting.length === 0) return elapsed
    if (elapsed >= timeoutSeconds) {
      throw new Error(
        `after ${timeoutSeconds}s, ${waiting.length} attestor(s) still do not watch the ${added} new protocols: ${waiting.join(', ')}`,
      )
    }
    await sleep(pollSeconds * 1000)
  }
}
