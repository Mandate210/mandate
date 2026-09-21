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
// its trigger signature (T070): one transaction on one protocol has exactly one
// incident address, and the second `open_incident` for it fails in the runtime before
// its bond moves. So the race is harmless on chain — what this module does is avoid
// paying a fee to lose it, and make sure the loser still attests:
//
//   1. derive the incident's address from the signature; if it exists, attest on it;
//   2. only open one if there is none;
//   3. if opening loses the race anyway, read the winner's incident and attest on it.
//
// Step 3 is not belt-and-braces. Between step 1 and the open there is a window of a
// whole round trip, which is exactly where the other attestors are. What it is *not*
// any more is a correctness measure: before T070 this module staggered opens by a
// random delay to narrow that window, and on devnet 22 of 45 triggers still ended up
// with two or three incidents each.
//
// **An attestor votes both ways.** An incident somebody else opened about a transaction
// this attestor finds declared gets an `authorized` attestation, because a set that can
// only ever say «unauthorized» cannot clear a false incident and the bond that backs it
// would never be forfeited (FR-007, FR-010).

import {
  type DeclarationEntry,
  type ObservedTransaction,
  evaluateTransaction,
} from '@mandate/shared'
import type { PrivilegedTransaction } from './watch'

/** The two classifications `Attestation` stores. */
export type AttestVerdict = 'unauthorized' | 'authorized'

/** `Protocol`, narrowed to what a decision needs. */
export interface ProtocolState {
  /** `Protocol.privileged` — the addresses whose involvement makes a transaction ours. */
  privileged: string[]
}

export interface IncidentRef {
  /** The incident account, base58. Derived from the protocol and the trigger. */
  address: string
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
  /** The incident of this protocol for this trigger signature, if it exists. There is
   * only one address it could be at. */
  findIncidentByTrigger(protocol: string, signature: string): Promise<IncidentRef | null>
  /** Returns the address the incident was opened at. */
  openIncident(input: { protocol: string; policySeq: number; signature: string }): Promise<string>
  /** Whether *this* attestor already has an attestation on the incident. */
  hasAttested(incident: string): Promise<boolean>
  attest(input: { protocol: string; incident: string; verdict: AttestVerdict }): Promise<void>
  /** Whether the incident is still taking attestations. */
  incidentOpen(incident: string): Promise<boolean>
  /** Whether the incident has the `unauthorized` attestations its quorum asks for. */
  quorumReached(incident: string): Promise<boolean>
  /** Records the quorum and pays out in one operation (FR-012). Permissionless. */
  resolve(protocol: string, incident: string): Promise<void>
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
      incident: string
      opened: boolean
      /** This attestation completed the quorum and this attestor paid it out. */
      settled: boolean
    }
  /** FR-009 holds: one attestor, one attestation. Reached by a restart re-delivering a
   * transaction this attestor already acted on. */
  | { kind: 'already-attested'; incident: string }

export interface ActLogger {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

const silentLogger: ActLogger = { info: () => {}, warn: () => {}, error: () => {} }

export interface Actor {
  act(transaction: PrivilegedTransaction): Promise<ActOutcome>
}

export const createActor = ({
  chain,
  logger = silentLogger,
}: {
  chain: ActChain
  logger?: ActLogger
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
    if (await chain.hasAttested(incident.address)) {
      return { kind: 'already-attested', incident: incident.address }
    }

    try {
      await chain.attest({ protocol, incident: incident.address, verdict })
    } catch (error) {
      // Both ways this loses are races, and both are diagnosed by re-reading the state
      // rather than by picking apart the error: another attestor's attestation may have
      // completed the quorum and settled the incident while this one was in flight, and
      // the program refuses attestations on a settled incident. Matching on error codes
      // here would be one refactor of the program away from silently swallowing a real
      // failure.
      if (await chain.hasAttested(incident.address)) {
        return { kind: 'already-attested', incident: incident.address }
      }
      if (!(await chain.incidentOpen(incident.address))) {
        return { kind: 'ignored', reason: 'incident-settled' }
      }
      throw error
    }

    logger.info({ protocol, incident: incident.address, verdict, opened }, 'attested')
    const settled = verdict === 'unauthorized' && (await settle(protocol, incident.address))
    return { kind: 'attested', verdict, incident: incident.address, opened, settled }
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
  const settle = async (protocol: string, incident: string): Promise<boolean> => {
    if (!(await chain.quorumReached(incident))) return false

    try {
      await chain.resolve(protocol, incident)
    } catch (error) {
      logger.warn({ protocol, incident, error }, 'quorum reached but resolve did not land')
      return false
    }

    logger.info({ protocol, incident }, 'quorum reached, paid out')
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
      logger.warn(
        { protocol, signature },
        'undeclared privileged transaction on an uncovered protocol',
      )
      return { kind: 'not-opened', reason: 'no-policy-in-force' }
    }

    logger.info(
      { protocol, signature, basis: verdict.basis, uncovered: verdict.uncovered.length },
      'opening incident',
    )

    let address: string
    try {
      address = await chain.openIncident({ protocol, policySeq, signature })
    } catch (error) {
      // Another attestor got there first — the expected outcome of the race, not a
      // fault, and the program made sure it cost nothing but the fee: the incident is
      // at the one address it can be at, so this attestor reads it and attests there.
      // Anything else is rethrown with the incident left for the next delivery.
      const winner = await chain.findIncidentByTrigger(protocol, signature)
      if (winner === null) throw error
      logger.info(
        { protocol, incident: winner.address },
        'lost the race to open, attesting instead',
      )
      return attestOn(protocol, winner, 'unauthorized', false)
    }

    return attestOn(protocol, { address, open: true }, 'unauthorized', true)
  }

  return { act }
}
