/**
 * The pages' view of the demonstration data — **a temporary adapter**, not a source.
 *
 * The data itself lives in `fixtures.ts`, in the shape of the public API contract.
 * This file turns those responses into what the pages were written against, so the
 * contract could land (T046) without rewriting every screen at once. It disappears in
 * T054/T055, when the pages read the contract directly.
 *
 * Nothing here adds a fact the contract does not carry. Where the pages once showed
 * invented names, they now show shortened addresses; where they showed recurring
 * windows and a «Spent» status the program has no notion of, they show the single
 * window and the state an entry actually has.
 */
import { type DeclarationEntryResponse, type EntryState, quorumNeeded } from '@mandate/shared'
import { ATTESTOR_KEYS, CONFIG, DECLARATIONS, INCIDENT_DETAIL, PROTOCOL_DETAILS } from './fixtures'

export type PolicyStatus = 'active' | 'none'

export type DeclarationStatus = 'Pending' | 'Scheduled' | 'Effective' | 'Expired' | 'Revoked'

export interface DeclarationEntry {
  operation: string
  window: string
  submitted: string
  effectiveFrom: string
  status: DeclarationStatus
}

export interface Protocol {
  id: string
  name: string
  poolCapital: number
  activeCoverage: number
  utilization: number
  attestors: number
  quorum: number
  policyStatus: PolicyStatus
  coverage: {
    limit: number
    retentionPct: number
    retentionAmount: number
    payable: number
    term: string
    beneficiary: string
  }
  declaration: DeclarationEntry[]
  signers: { label: string; address: string }[]
}

/** `Abcd…wxyz` — enough to recognise an address, the way explorers abbreviate. */
export const short = (address: string): string => `${address.slice(0, 4)}…${address.slice(-4)}`

/** Base units to whole dollars, for display only. */
const dollars = (amount: string): number =>
  Number(BigInt(amount) / 10n ** BigInt(CONFIG.asset_decimals))

const day = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10)
const minute = (ts: number): string =>
  new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
const second = (ts: number): string =>
  `${new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`

const STATUS: Record<EntryState, DeclarationStatus> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  effective: 'Effective',
  expired: 'Expired',
  revoked: 'Revoked',
}

/** The instruction's name when its program publishes one; otherwise what the chain holds. */
const operationOf = (entry: DeclarationEntryResponse): string =>
  entry.instruction?.name ?? `${short(entry.program_id)} · ${entry.ix_discriminator}`

const windowOf = (entry: DeclarationEntryResponse): string =>
  entry.not_after === null
    ? `from ${minute(entry.not_before)} UTC, permanent`
    : `${minute(entry.not_before)} – ${minute(entry.not_after).slice(-5)} UTC`

const declarationRow = (entry: DeclarationEntryResponse): DeclarationEntry => ({
  operation: operationOf(entry),
  window: windowOf(entry),
  submitted: day(entry.submitted_at),
  effectiveFrom: day(entry.effective_at),
  status: STATUS[entry.state],
})

const QUORUM = quorumNeeded(CONFIG.attestor_count, CONFIG.quorum_bps)

export const PROTOCOLS: Protocol[] = PROTOCOL_DETAILS.map((detail) => {
  const policy = detail.policies.find((p) => p.in_force)
  const limit = policy === undefined ? 0 : dollars(policy.limit)
  const retention = policy === undefined ? 0 : dollars(policy.retention)
  return {
    id: detail.protocol.address,
    name: short(detail.protocol.address),
    poolCapital: dollars(detail.pool.total_assets),
    activeCoverage: dollars(detail.pool.locked_limit),
    utilization: Math.floor(detail.pool.utilization_bps / 100),
    attestors: CONFIG.attestor_count,
    quorum: QUORUM,
    policyStatus: policy === undefined ? 'none' : 'active',
    coverage: {
      limit,
      retentionPct: limit === 0 ? 0 : Math.round((retention / limit) * 100),
      retentionAmount: retention,
      payable: policy === undefined ? 0 : dollars(policy.payable),
      term: policy === undefined ? '—' : `until ${day(policy.end_ts)}`,
      beneficiary: short(policy?.beneficiary ?? detail.protocol.treasury),
    },
    declaration: (
      DECLARATIONS.find((d) => d.protocol === detail.protocol.address)?.entries ?? []
    ).map(declarationRow),
    signers: detail.protocol.privileged.map((address, i) => ({
      label: `privileged ${i + 1}`,
      address: short(address),
    })),
  }
})

export const getProtocol = (id?: string) => PROTOCOLS.find((p) => p.id === id)

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
  triggerAt: second(triggerAt),
  openedAt: second(incident.opened_at),
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
      timestamp: second(a.submitted_at),
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
    timestamp: second(triggerAt),
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
    timestamp: second(detail.opened.at),
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
          timestamp: second(payout.at),
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
    effectiveFrom: day(entry.effective_at),
    status: STATUS[entry.state],
  }),
)

export function usdc(n: number) {
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} USDC`
}
