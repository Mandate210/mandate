/**
 * All data in this file is invented for demonstration purposes.
 * No real protocol names, addresses or transaction signatures are used.
 * Signatures and addresses are truncated placeholders only.
 */

export type PolicyStatus = 'active' | 'none'

export interface DeclarationEntry {
  operation: string
  window: string
  submitted: string
  effectiveFrom: string
  status: 'Effective' | 'Pending' | 'Spent' | 'Revoked'
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

export const PROTOCOLS: Protocol[] = [
  {
    id: 'meridian-perps',
    name: 'Meridian Perps',
    poolCapital: 4_200_000,
    activeCoverage: 3_000_000,
    utilization: 71,
    attestors: 7,
    quorum: 5,
    policyStatus: 'active',
    coverage: {
      limit: 3_000_000,
      retentionPct: 20,
      retentionAmount: 600_000,
      payable: 2_400_000,
      term: 'until 2026-12-31',
      beneficiary: 'MerdN…8kQ2',
    },
    declaration: [
      {
        operation: 'Update funding rate params',
        window: 'Tue 02:00–04:00 UTC',
        submitted: '2026-07-14',
        effectiveFrom: '2026-07-16',
        status: 'Effective',
      },
      {
        operation: 'Add collateral market',
        window: 'one-off 2026-08-02',
        submitted: '2026-07-30',
        effectiveFrom: '2026-08-01',
        status: 'Spent',
      },
      {
        operation: 'Rotate oracle authority',
        window: 'Thu 01:00–03:00 UTC',
        submitted: '2026-08-08',
        effectiveFrom: '2026-08-10',
        status: 'Pending',
      },
    ],
    signers: [
      { label: 'council-1', address: 'A7hK…3nDv' },
      { label: 'council-2', address: 'Qm2X…9tLb' },
      { label: 'council-3', address: 'F4pR…6wZs' },
      { label: 'council-4', address: 'Ub9C…1yKe' },
      { label: 'council-5', address: 'Ns5T…7gHm' },
    ],
  },
  {
    id: 'solstice-lend',
    name: 'Solstice Lend',
    poolCapital: 1_150_000,
    activeCoverage: 750_000,
    utilization: 65,
    attestors: 7,
    quorum: 5,
    policyStatus: 'active',
    coverage: {
      limit: 750_000,
      retentionPct: 15,
      retentionAmount: 112_500,
      payable: 637_500,
      term: 'until 2026-11-30',
      beneficiary: 'SolsT…4vR7',
    },
    declaration: [
      {
        operation: 'Adjust reserve factor',
        window: 'Mon 03:00–05:00 UTC',
        submitted: '2026-06-22',
        effectiveFrom: '2026-06-24',
        status: 'Effective',
      },
      {
        operation: 'List new lending market',
        window: 'one-off 2026-07-19',
        submitted: '2026-07-16',
        effectiveFrom: '2026-07-18',
        status: 'Spent',
      },
      {
        operation: 'Raise liquidation threshold',
        window: 'Wed 02:00–03:30 UTC',
        submitted: '2026-08-05',
        effectiveFrom: '2026-08-07',
        status: 'Effective',
      },
      {
        operation: 'Pause borrowing (emergency)',
        window: 'any time',
        submitted: '2026-05-02',
        effectiveFrom: '2026-05-04',
        status: 'Effective',
      },
    ],
    signers: [
      { label: 'council-1', address: 'Zc8M…2qPa' },
      { label: 'council-2', address: 'Rv3J…8sXn' },
      { label: 'council-3', address: 'Dk6W…4hTy' },
      { label: 'council-4', address: 'Ly1B…5cVf' },
      { label: 'council-5', address: 'Ha9G…3mQr' },
    ],
  },
  {
    id: 'kestrel-vaults',
    name: 'Kestrel Vaults',
    poolCapital: 380_000,
    activeCoverage: 0,
    utilization: 0,
    attestors: 7,
    quorum: 5,
    policyStatus: 'none',
    coverage: {
      limit: 0,
      retentionPct: 0,
      retentionAmount: 0,
      payable: 0,
      term: '—',
      beneficiary: 'KestV…2mB9',
    },
    declaration: [
      {
        operation: 'Update vault strategy weights',
        window: 'Fri 04:00–06:00 UTC',
        submitted: '2026-07-28',
        effectiveFrom: '2026-07-30',
        status: 'Effective',
      },
      {
        operation: 'Rotate keeper authority',
        window: 'one-off 2026-08-15',
        submitted: '2026-08-09',
        effectiveFrom: '2026-08-11',
        status: 'Pending',
      },
    ],
    signers: [
      { label: 'council-1', address: 'Tw4N…7bLk' },
      { label: 'council-2', address: 'Ev2S…9dRc' },
      { label: 'council-3', address: 'Pj7Y…1fWx' },
      { label: 'council-4', address: 'Cx5H…6nGt' },
      { label: 'council-5', address: 'Ma3Q…8zJv' },
    ],
  },
]

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

export const INCIDENT = {
  id: 'INC-0417',
  protocolId: 'meridian-perps',
  protocolName: 'Meridian Perps',
  openedAt: '2026-08-11 09:14:02 UTC',
  bond: 500,
  quorumRequired: 5,
  attestorSetSize: 7,
  acceptanceWindow: 300,
  payoutAmount: 2_400_000,
  beneficiary: 'MerdN…8kQ2',
  beneficiaryLabel: 'Meridian Perps treasury',
  triggerSignature: '5xK2…9fPq',
  payoutSignature: '7fLp…3sQe',
  settledAt: 22,
}

export const ATTESTOR_SET = [
  'attestor-01',
  'attestor-02',
  'attestor-03',
  'attestor-04',
  'attestor-05',
  'attestor-06',
  'attestor-07',
]

export const TIMELINE: TimelineEvent[] = [
  {
    id: 'ev-trigger',
    t: 0,
    kind: 'trigger',
    title: 'Privileged transaction',
    signature: '5xK2…9fPq',
    timestamp: '2026-08-11 09:14:02 UTC',
    lines: [
      'signer 3 of 5 · durable nonce · outside maintenance window',
      '✗ matches no effective declaration entry',
    ],
  },
  {
    id: 'ev-opened',
    t: 4,
    kind: 'opened',
    title: 'Incident opened',
    signature: 'Bn6V…4xTd',
    timestamp: '2026-08-11 09:14:06 UTC',
    lines: ['bond 500 USDC', 'quorum 5 of 7 · attestations accepted until T+300s'],
  },
  {
    id: 'ev-a02',
    t: 9,
    kind: 'attestation',
    title: 'Attestation',
    attestor: 'attestor-02',
    verdict: 'unauthorized',
    tally: 1,
    signature: '9pQr…2Lm4',
    timestamp: '2026-08-11 09:14:11 UTC',
  },
  {
    id: 'ev-a05',
    t: 12,
    kind: 'attestation',
    title: 'Attestation',
    attestor: 'attestor-05',
    verdict: 'unauthorized',
    tally: 2,
    signature: '3bTn…7yWc',
    timestamp: '2026-08-11 09:14:14 UTC',
  },
  {
    id: 'ev-a01',
    t: 15,
    kind: 'attestation',
    title: 'Attestation',
    attestor: 'attestor-01',
    verdict: 'authorized',
    signature: 'Hq4Z…1dRv',
    timestamp: '2026-08-11 09:14:17 UTC',
  },
  {
    id: 'ev-a03',
    t: 18,
    kind: 'attestation',
    title: 'Attestation',
    attestor: 'attestor-03',
    verdict: 'unauthorized',
    tally: 3,
    signature: '8kMx…5tGa',
    timestamp: '2026-08-11 09:14:20 UTC',
  },
  {
    id: 'ev-a07',
    t: 20,
    kind: 'attestation',
    title: 'Attestation',
    attestor: 'attestor-07',
    verdict: 'unauthorized',
    tally: 4,
    signature: '2wYb…6nJd',
    timestamp: '2026-08-11 09:14:22 UTC',
  },
  {
    id: 'ev-a04',
    t: 22,
    kind: 'attestation',
    title: 'Attestation',
    attestor: 'attestor-04',
    verdict: 'unauthorized',
    tally: 5,
    quorumReached: true,
    signature: '7fLp…3sQe',
    timestamp: '2026-08-11 09:14:24 UTC',
  },
  {
    id: 'ev-payout',
    t: 22,
    kind: 'payout',
    title: 'PAYOUT 2,400,000 USDC → Meridian Perps treasury',
    signature: '7fLp…3sQe',
    timestamp: '2026-08-11 09:14:24 UTC',
    lines: ['released by the same transaction that recorded the quorum'],
  },
]

export const ATTESTATIONS = TIMELINE.filter((e) => e.kind === 'attestation')

/* Declaration snapshot as it stood when the incident opened */
export const DECLARATION_SNAPSHOT = [
  {
    operation: 'Update funding rate params',
    window: 'Tue 02:00–04:00 UTC',
    effectiveFrom: '2026-07-16',
    status: 'Effective',
  },
  {
    operation: 'Add collateral market',
    window: 'one-off 2026-08-02',
    effectiveFrom: '2026-08-01',
    status: 'Spent',
  },
  {
    operation: 'Rotate oracle authority',
    window: 'Thu 01:00–03:00 UTC',
    effectiveFrom: '2026-08-10',
    status: 'Pending — not yet effective',
  },
]

export const usdc = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} USDC`
