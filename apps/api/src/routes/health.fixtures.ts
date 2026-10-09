// Attestor heartbeats for tests of `/health`, built through the same rule an attestor
// serves them by — a hand-written report could pass the schema and still say something
// no attestor would.

import { type AttestorReport, judgeAttestor } from '@mandate/shared'
import { Keypair } from '@solana/web3.js'
import type { AttestorProbe } from './health'

/** Seconds; any clock will do, since every age is measured inside the report. */
export const REPORT_NOW = 1_800_000_000

/**
 * A healthy attestor: stream ticking, a complete sweep a minute ago, nothing stuck.
 *
 * `examined_slot` defaults far past any tip a test sets, so the attestor is never what
 * puts a test's `/health` behind — tests that want lag ask for it.
 */
export const attestorReport = (
  overrides: Partial<Omit<AttestorReport, 'ok' | 'reason'>> = {},
): AttestorReport => {
  const facts = {
    attestor: Keypair.generate().publicKey.toBase58(),
    now: REPORT_NOW,
    examined_slot: 1_000_000_000,
    stream: { slot: 1_000_000_000, at: REPORT_NOW - 1 },
    last_complete_sweep: { slot: 1_000_000_000, at: REPORT_NOW - 60 },
    pending: 0,
    protocols: 3,
    policy: { stall_seconds: 30, poll_seconds: 60, reconcile_seconds: 600 },
    ...overrides,
  }
  const { ok, reason } = judgeAttestor(facts)
  return { ...facts, ok, reason }
}

/** `count` distinct live attestors, as `probeAttestors` would hand them over. */
export const liveAttestors = (count: number) => async (): Promise<AttestorProbe[]> =>
  Array.from({ length: count }, () => ({ report: attestorReport() }))
