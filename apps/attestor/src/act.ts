// What an attestor does with a privileged transaction (T027, FR-006, FR-007).
//
// `watch.ts` decides which transactions are worth looking at, `packages/shared` decides
// what they mean, and this module is the only part that writes to the chain. It holds
// no opinion of its own: every verdict here comes out of `evaluateTransaction`, so an
// attestor is reproducible from public state and two honest attestors cannot disagree
// (SC-007).
//
// **Several attestors race, and that is the normal case, not the edge case.** They all
// watch the same addresses and reach the same verdict at roughly the same second, so
// each of them tries to open the same incident. The program addresses an incident by
// `(protocol, seq)` and not by the transaction that triggered it, so nothing on chain
// stops two of them from becoming two incidents about one event — which would freeze
// the pool's capital twice and put two bonds at risk over one compromise. Idempotence
// is therefore this module's job, and it is keyed on the trigger signature:
//
//   1. look for an incident that already carries this signature, and attest on it;
//   2. only open one if there is none;
//   3. if opening loses the race anyway, look again and attest on the winner.
//
// Step 3 is not belt-and-braces. Between step 1 and the open there is a window of a
// whole round trip, which is exactly where the other attestors are.
//
// **An attestor votes both ways.** An incident somebody else opened about a transaction
// this attestor finds declared gets an `authorized` attestation, because a set that can
// only ever say «unauthorized» cannot clear a false incident and the bond that backs it
// would never be forfeited (FR-007, FR-010).

import {
  type DeclarationEntry,
  type ObservedTransaction,
  evaluateTransaction,
} from '@drain-cover/shared'
import type { PrivilegedTransaction } from './watch'

/** The two classifications `Attestation` stores. */
export type AttestVerdict = 'unauthorized' | 'authorized'

/** `Protocol`, narrowed to what a decision needs. */
export interface ProtocolState {
  /** `Protocol.privileged` — the addresses whose involvement makes a transaction ours. */
  privileged: string[]
}

export interface IncidentRef {
  seq: number
  /** A settled incident takes no more attestations; the program refuses them. */
  open: boolean
}

/**
 * The chain surface this module uses, and nothing more.
 *
 * Narrow for the same reason `WatchRpc` is: it is what lets the decision be tested
 * against a fake on a machine with no validator and no network, which is the rule
 * `pnpm gate` is built on (`CLAUDE.md` → «Two test suites, on purpose»).
 */
export interface ActChain {
  /** The transaction as the cluster has it, in the shape the rule reads. `null` when the
   * cluster will not serve it, or when it failed on chain and never had any effect. */
  fetchTransaction(signature: string): Promise<ObservedTransaction | null>
  loadProtocol(protocol: string): Promise<ProtocolState | null>
  /** Every entry of the protocol's declaration, as stored. The rule needs all of them:
   * it decides which were effective at the transaction's own clock, not at ours. */
  loadDeclaration(protocol: string): Promise<DeclarationEntry[]>
  /** The sequence number of a policy the program will accept an incident against. */
  findPolicyInForce(protocol: string): Promise<number | null>
  /** An incident of this protocol already carrying this trigger signature. */
  findIncidentByTrigger(protocol: string, signature: string): Promise<IncidentRef | null>
  /** Returns the sequence number the incident was opened at. */
  openIncident(input: { protocol: string; policySeq: number; signature: string }): Promise<number>
  /** Whether *this* attestor already has an attestation on the incident. */
  hasAttested(protocol: string, incidentSeq: number): Promise<boolean>
  attest(input: {
    protocol: string
    incidentSeq: number
    verdict: AttestVerdict
  }): Promise<void>
  /** Whether the incident is still taking attestations. */
  incidentOpen(protocol: string, incidentSeq: number): Promise<boolean>
  /** Whether the incident has the `unauthorized` attestations its quorum asks for. */
  quorumReached(protocol: string, incidentSeq: number): Promise<boolean>
  /** Records the quorum and pays out in one operation (FR-012). Permissionless. */
  resolve(protocol: string, incidentSeq: number): Promise<void>
}

export type IgnoreReason =
  /** The RPC would not serve it, or it failed on chain and changed nothing. */
  | 'unfetchable'
  /** Registered protocols only: the watcher outlives a deregistration. */
  | 'unknown-protocol'
  /** The privileged addresses are nowhere in it — the watcher's superset, trimmed. */
  | 'not-privileged'
  /** Declared, and nobody has opened an incident to vote down. The common case. */
  | 'declared'
  /** Declared or not, the incident is settled and takes no more attestations. */
  | 'incident-settled'

export type ActOutcome =
  | { kind: 'ignored'; reason: IgnoreReason }
  /** Nothing was opened, because the program would have refused it (`validate_open`).
   * Reported rather than swallowed: a protocol whose cover has lapsed while its keys
   * are being used is worth seeing in a log. */
  | { kind: 'not-opened'; reason: 'no-policy-in-force' }
  | {
      kind: 'attested'
      verdict: AttestVerdict
      incidentSeq: number
      opened: boolean
      /** This attestation completed the quorum and this attestor paid it out. */
      settled: boolean
    }
  /** FR-009 holds: one attestor, one attestation. Reached by a restart re-delivering a
   * transaction this attestor already acted on. */
  | { kind: 'already-attested'; incidentSeq: number }

export interface ActLogger {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

const silentLogger: ActLogger = { info: () => {}, warn: () => {}, error: () => {} }

export interface Actor {
  act(transaction: PrivilegedTransaction): Promise<ActOutcome>
}

/**
 * How long an attestor holds off before opening an incident nobody has opened yet, and
 * why it holds off at all.
 *
 * Every attestor sees the same transaction within milliseconds of the others and reaches
 * the same verdict, so without a stagger they all pass the «has anyone opened one?»
 * check in the same instant and every one of them opens its own. The program does not
 * stop them: an incident is addressed by `(protocol, seq)`, so two incidents about one
 * event are two perfectly valid accounts — and the attestations then split between them,
 * leaving *neither* at quorum. Measured, not imagined: this is what a three-attestor
 * scenario did to one compromise in ten before the stagger existed.
 *
 * A random wait spreads the herd, and the second look afterwards is what actually
 * prevents the duplicate — the wait only makes it likely that there is something to see.
 * Cheap against SC-001's thirty-second budget.
 *
 * **This narrows the window rather than closing it.** Two attestors that draw similar
 * waits can still both open, because nothing on chain makes a trigger signature unique.
 * Closing it properly means addressing an incident by its trigger, which is a change to
 * the program and to everything that derives an incident address (`docs/PLAN.md` →
 * «Один інцидент на подію»).
 */
export const DEFAULT_OPEN_JITTER_MS = 1_500

export const createActor = ({
  chain,
  logger = silentLogger,
  openJitterMs = DEFAULT_OPEN_JITTER_MS,
  random = Math.random,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  chain: ActChain
  logger?: ActLogger
  openJitterMs?: number
  /** Injected so a test can make the stagger deterministic. */
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}): Actor => {
  /**
   * Record this attestor's verdict on an incident that exists.
   *
   * The `hasAttested` check ahead of the write is a courtesy, not the guarantee: the
   * guarantee is the attestation PDA, whose seeds are `(incident, attestor)`, so a
   * second attestation cannot be created however hard anyone tries. What the check buys
   * is not paying a fee to be told so. The same reasoning is why the failure path asks
   * again instead of reporting an error — losing that race means the work is done.
   */
  const attestOn = async (
    protocol: string,
    incident: IncidentRef,
    verdict: AttestVerdict,
    opened: boolean,
  ): Promise<ActOutcome> => {
    if (!incident.open) return { kind: 'ignored', reason: 'incident-settled' }
    if (await chain.hasAttested(protocol, incident.seq)) {
      return { kind: 'already-attested', incidentSeq: incident.seq }
    }

    try {
      await chain.attest({ protocol, incidentSeq: incident.seq, verdict })
    } catch (error) {
      // Both ways this loses are races, and both are diagnosed by re-reading the state
      // rather than by picking apart the error: another attestor's attestation may have
      // completed the quorum and settled the incident while this one was in flight, and
      // the program refuses attestations on a settled incident. Matching on error codes
      // here would be one refactor of the program away from silently swallowing a real
      // failure.
      if (await chain.hasAttested(protocol, incident.seq)) {
        return { kind: 'already-attested', incidentSeq: incident.seq }
      }
      if (!(await chain.incidentOpen(protocol, incident.seq))) {
        return { kind: 'ignored', reason: 'incident-settled' }
      }
      throw error
    }

    logger.info({ protocol, incidentSeq: incident.seq, verdict, opened }, 'attested')
    const settled = verdict === 'unauthorized' && (await settle(protocol, incident.seq))
    return { kind: 'attested', verdict, incidentSeq: incident.seq, opened, settled }
  }

  /**
   * Pay out, if this attestation was the one that completed the quorum.
   *
   * **Without this nothing closes the loop.** FR-012 says the payout is initiated by
   * the same operation that records the quorum, and `resolve` is that operation — but
   * it is permissionless and takes no signer, so the program cannot call it and nobody
   * is obliged to. An attestor that stops at its own attestation leaves the incident
   * sitting at quorum until its deadline passes and `close_expired_incident` closes it
   * with no payout: the decision made, and the money not sent. So whoever casts the
   * deciding attestation carries it through.
   *
   * Only after an `unauthorized` attestation, because that is the only verdict the
   * quorum counts (FR-010) — an `authorized` vote can never be the one that completes
   * it.
   *
   * **A failure here is logged, not raised.** Every way this loses is a race it was
   * expected to lose: another attestor resolved first and the incident is no longer
   * open, or the policy lapsed in the seconds since the attestation. Neither loses the
   * incident — it is either settled already or will close on its deadline — and taking
   * the worker down over it would cost the next compromise.
   */
  const settle = async (protocol: string, incidentSeq: number): Promise<boolean> => {
    if (!(await chain.quorumReached(protocol, incidentSeq))) return false

    try {
      await chain.resolve(protocol, incidentSeq)
    } catch (error) {
      logger.warn({ protocol, incidentSeq, error }, 'quorum reached but resolve did not land')
      return false
    }

    logger.info({ protocol, incidentSeq }, 'quorum reached, paid out')
    return true
  }

  const act = async (delivered: PrivilegedTransaction): Promise<ActOutcome> => {
    const { protocol, signature } = delivered

    const state = await chain.loadProtocol(protocol)
    if (state === null) return { kind: 'ignored', reason: 'unknown-protocol' }

    const transaction = await chain.fetchTransaction(signature)
    if (transaction === null) return { kind: 'ignored', reason: 'unfetchable' }

    const verdict = evaluateTransaction({
      transaction,
      entries: await chain.loadDeclaration(protocol),
      privileged: state.privileged,
    })

    if (verdict.status === 'not-privileged') return { kind: 'ignored', reason: 'not-privileged' }

    const existing = await chain.findIncidentByTrigger(protocol, signature)

    if (verdict.status === 'declared') {
      if (existing === null) return { kind: 'ignored', reason: 'declared' }
      return attestOn(protocol, existing, 'authorized', false)
    }

    if (existing !== null) return attestOn(protocol, existing, 'unauthorized', false)

    // The program refuses an incident against a policy that is not in force, and it is
    // right to (`validate_open`): opening one would freeze pool capital and burn a bond
    // on a claim that could never pay out (FR-016).
    const policySeq = await chain.findPolicyInForce(protocol)
    if (policySeq === null) {
      logger.warn({ protocol, signature }, 'undeclared privileged transaction on an uncovered protocol')
      return { kind: 'not-opened', reason: 'no-policy-in-force' }
    }

    // Stagger, then look again. The first check was made the instant the transaction
    // arrived, when every other attestor was making the same one.
    if (openJitterMs > 0) {
      await sleep(Math.floor(random() * openJitterMs))
      const opened = await chain.findIncidentByTrigger(protocol, signature)
      if (opened !== null) {
        logger.info({ protocol, incidentSeq: opened.seq }, 'another attestor opened it first')
        return attestOn(protocol, opened, 'unauthorized', false)
      }
    }

    logger.info(
      { protocol, signature, basis: verdict.basis, uncovered: verdict.uncovered.length },
      'opening incident',
    )

    let seq: number
    try {
      seq = await chain.openIncident({ protocol, policySeq, signature })
    } catch (error) {
      // Another attestor got there first — the expected outcome of the race, not a
      // fault. Anything else is rethrown with the incident left for the next delivery.
      const winner = await chain.findIncidentByTrigger(protocol, signature)
      if (winner === null) throw error
      logger.info({ protocol, incidentSeq: winner.seq }, 'lost the race to open, attesting instead')
      return attestOn(protocol, winner, 'unauthorized', false)
    }

    return attestOn(protocol, { seq, open: true }, 'unauthorized', true)
  }

  return { act }
}
