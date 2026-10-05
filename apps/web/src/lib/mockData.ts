/**
 * The pages' view of the demonstration data — **a temporary adapter**, not a source.
 *
 * The data itself lives in `fixtures.ts`, in the shape of the public API contract.
 * This file turns those responses into what the pages were written against, so the
 * contract could land (T046) without rewriting every screen at once. The pool pages read
 * the contract since T054; what is left here goes in T055 with the incident pages.
 *
 * Nothing here adds a fact the contract does not carry. Where the pages once showed
 * invented names, they now show shortened addresses; where they showed recurring
 * windows and a «Spent» status the program has no notion of, they show the single
 * window and the state an entry actually has.
 */
import { ATTESTOR_KEYS, CONFIG, INCIDENT_DETAIL, PROTOCOL_DETAILS } from './fixtures'
import { ENTRY_STATE, operationOf, short, utcDay, utcSecond, windowOf } from './format'

/** Base units to whole dollars, for display only. */
const dollars = (amount: string): number =>
  Number(BigInt(amount) / 10n ** BigInt(CONFIG.asset_decimals))

/* ---------------------------------------------------------------- */
/* Incident                                                          */
/* ---------------------------------------------------------------- */

export type EventKind = 'trigger' | 'opened' | 'attestation' | 'payout'
export type Verdict = 'unauthorized' | 'authorized'

export interface TimelineEvent {
  id: string
  t: number // seconds after the trigger transaction
  kind: EventKind
  title: string
  signature: string
  timestamp: string // UTC
  lines?: string[]
  attestor?: string
  verdict?: Verdict
  tally?: number // running count of "unauthorized" attestations
  quorumReached?: boolean
}

const detail = INCIDENT_DETAIL
const incident = detail.incident
const payout = detail.payout
const protocolOfIncident = PROTOCOL_DETAILS.find((p) => p.protocol.address === incident.protocol)
const triggerAt = detail.trigger.block_time ?? incident.opened_at

/** What the chain can say about the beneficiary: whether it is the protocol's own treasury. */
const beneficiaryLabel =
  payout !== null && payout.beneficiary === protocolOfIncident?.protocol.treasury
    ? 'protocol treasury'
    : 'beneficiary'

export const INCIDENT = {
  /** The full address: it is what a route and the API name the incident by. */
  id: incident.address,
  label: short(incident.address),
  protocolId: incident.protocol,
  protocolName: short(incident.protocol),
  triggerAt: utcSecond(triggerAt),
  openedAt: utcSecond(incident.opened_at),
  bond: dollars(incident.bond),
  quorumRequired: incident.quorum_needed,
  attestorSetSize: incident.set_size,
  /** Seconds from the trigger to the opening: the window runs from the opening, not the trigger. */
  openedAfter: incident.opened_at - triggerAt,
  acceptanceWindow: incident.deadline - incident.opened_at,
  payoutAmount: payout === null ? 0 : dollars(payout.amount),
  beneficiary: short(payout?.beneficiary ?? ''),
  beneficiaryLabel,
  triggerSignature: short(incident.trigger_signature),
  payoutSignature: payout === null ? '' : short(payout.signature),
  settledAt: payout === null ? 0 : payout.at - triggerAt,
}

const attestorName = (key: string): string =>
  `attestor-${String(ATTESTOR_KEYS.indexOf(key) + 1).padStart(2, '0')}`

export const ATTESTOR_SET = ATTESTOR_KEYS.map(attestorName)

const effectiveAtTrigger = detail.verification.declaration_at_trigger.entries.filter(
  (e) => e.state === 'effective',
).length

const attestationEvents: TimelineEvent[] = (() => {
  let tally = 0
  return detail.attestations.map((a) => {
    if (a.verdict === 'unauthorized') tally += 1
    const reached = a.verdict === 'unauthorized' && tally === incident.quorum_needed
    return {
      id: `ev-${attestorName(a.attestor)}`,
      t: a.submitted_at - triggerAt,
      kind: 'attestation',
      title: 'Attestation',
      attestor: attestorName(a.attestor),
      verdict: a.verdict,
      ...(a.verdict === 'unauthorized' ? { tally } : {}),
      ...(reached ? { quorumReached: true } : {}),
      signature: short(a.signature ?? ''),
      timestamp: utcSecond(a.submitted_at),
    }
  })
})()

export const TIMELINE: TimelineEvent[] = [
  {
    id: 'ev-trigger',
    t: 0,
    kind: 'trigger',
    title: 'Privileged transaction',
    signature: short(detail.trigger.signature),
    timestamp: utcSecond(triggerAt),
    lines: [
      `signed by a privileged address of ${short(incident.protocol)}`,
      `✗ matches no effective declaration entry (${effectiveAtTrigger} in force)`,
    ],
  },
  {
    id: 'ev-opened',
    t: detail.opened.at - triggerAt,
    kind: 'opened',
    title: 'Incident opened',
    signature: short(detail.opened.signature ?? ''),
    timestamp: utcSecond(detail.opened.at),
    lines: [
      `bond ${usdc(dollars(incident.bond))}`,
      `quorum ${incident.quorum_needed} of ${incident.set_size} · attestations accepted until T+${incident.deadline - triggerAt}s`,
    ],
  },
  ...attestationEvents,
  ...(payout === null
    ? []
    : [
        {
          id: 'ev-payout',
          t: payout.at - triggerAt,
          kind: 'payout' as const,
          title: `PAYOUT ${usdc(dollars(payout.amount))} → ${beneficiaryLabel}`,
          signature: short(payout.signature),
          timestamp: utcSecond(payout.at),
          lines: ['released by the same transaction that recorded the quorum'],
        },
      ]),
]

export const ATTESTATIONS = TIMELINE.filter((e) => e.kind === 'attestation')

/* Declaration as it stood at the trigger — the moment the rule evaluates it */
export const DECLARATION_SNAPSHOT = detail.verification.declaration_at_trigger.entries.map(
  (entry) => ({
    operation: operationOf(entry),
    window: windowOf(entry),
    effectiveFrom: utcDay(entry.effective_at),
    status: ENTRY_STATE[entry.state],
  }),
)

export function usdc(n: number) {
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} USDC`
}
