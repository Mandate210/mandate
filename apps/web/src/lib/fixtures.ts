/**
 * Demonstration data in the shape of the public API contract (`@mandate/shared` →
 * `api.ts`), so that switching `web` to the real API (T053) replaces a source, not a
 * model. `fixtures.test.ts` parses every response here with the contract's schemas.
 *
 * All of it is invented. The addresses and signatures are well-formed but belong to
 * nobody: each is a hash of a label (`mandate-mock:<label>`), so they are stable across
 * builds and cannot collide with a real account by anything but chance. There are no
 * protocol names — the contract carries none (only what the chain can back) — and the
 * instruction names stand for what a declared program's on-chain Anchor IDL would say.
 *
 * Derived fields (`state`, `in_force`, `utilization_bps`, `quorum_needed`, `payable`)
 * are computed with the same functions the API uses, never typed in.
 */
import {
  type AsOf,
  type ConfigResponse,
  type DeclarationEntryResponse,
  type DeclarationsResponse,
  type IncidentDetailResponse,
  type IncidentSummary,
  type Policy,
  type PoolSummary,
  type PoolsResponse,
  type ProtocolDetailResponse,
  entryStateAt,
  payable,
  quorumNeeded,
  utilizationBps,
} from '@mandate/shared'

const K = {
  program: '5EXR3NpMkPRcEGJCPmJZWFDU6FpNRGjmDhFikcd4XSga',
  admin: '9qjkyv3e5N3foMrGSqp2fZAfXq9vQYbqBRdhU1VnekR',
  mint: '2EUhCXDaTgaDp1a9FmNzTuBhoUZAxHsXVW4MoR5u8JHR',
  config: '9NARVcR4cS3NrWYMaA8m61z9B5pDvWEy4qrETBCpu3vy',
  'meridian:protocol': 'HwV6cgZGYn6hWdTxxVnvfX3Kw4Pg3Gkz4ryvDA3shw4T',
  'meridian:protocol_id': 'Aed6JBx1aZsVQPPob61B1WWHKZ6uNX6WJicu4w66RheR',
  'meridian:authority': 'HoH6QVBaYxEYYzp2oXhXtAko3ukRUbqnpWbuaoJDQZGt',
  'meridian:treasury': '7i4GQun1b1xkDuK89jeh8cZARGETabFccLUgtiuFKXqs',
  'meridian:pool': 'DzPX2rH4coGaQcnqNCg5MCgbMWRkiWLLG1qDmxKkJq7F',
  'meridian:vault': '9PZqB9EfXqc4iK4d9J4CDzbws9zBYDtzoBHbbVXMwvVv',
  'meridian:policy': '8U3hbY3hLdu2XAGoEqgSPEW2Ak332czqiSZAPDU9ht5e',
  'meridian:privileged1': '22dYYvnBax34ZcQpkodZ4MeiTkqXBZuRuXx9MNpp5Dtj',
  'meridian:privileged2': '3RSCCG3MmdbPPK7r3jkX7EpJPZVkQPn2i5coFNqMD9Jp',
  'meridian:privileged3': '6KtBoA6zyf2oxuA7Wp4St8ntDaeetiCkNzFTwEn95Fm1',
  'meridian:privileged4': 'HAsHknHPtVyYri7x89WbVyC5Y4v1jSC8p3H8XcJiy9jF',
  'meridian:privileged5': '13KNxpf1K4wUxHscyZTEitH5qi5z5oc8TiKNXscPEF84',
  'meridian:decl0': 'AxQ45U1ksybgPitXhvCUuq7mtBraBby7cnkAUdiJZMRZ',
  'meridian:decl1': 'EUy5uy3XSvQG85WphwD1WkVS6fhMFDJXGZwzJLr5jH62',
  'meridian:decl2': 'CNRFquifH6X2ALQvyZA7CZfHwjLyoibJV7Pbbhrc1KoE',
  'meridian:decl3': 'C5NdK6Y1yq34BoUkKi3tg9wuAJhLWefv94gpV3arLkNA',
  'meridian:decl-program': 'DV4j5BGiNYwjfWp6eW73oiPExnSxp4H4vq6rVg9Xo5Wx',
  'solstice:protocol': 'FkNrzePUdpwGhy8NcmLDuPmbpeJdj81mJyVR1epC5CWw',
  'solstice:protocol_id': 'G37YGcf96ZCJKk3RLba2osW13fZRwWsCdueA8d6nBZ2V',
  'solstice:authority': '94xMR8Pi2q1a7mB5ygEQfvSXykc8NGxnPAVzFGWwYBpV',
  'solstice:treasury': '3hxnJNJVfmc89WtdzXR76pCCQbLBHGoU1UXmuozZc8jJ',
  'solstice:pool': '4aa75XUqXYj6QyD8zuFoBVZEm76SM99uKUGCR92rVQGL',
  'solstice:vault': '4442bcTVxPTJ69yLiGCj28V1CeKTuDd8Gd5jxZbouAnS',
  'solstice:policy': 'B9fbivYoHSB76fZBpmsAp76FWdcbWyyEru8mG3WutgnA',
  'solstice:privileged1': 'EtzSeumZHUQDnoX3MFhRFtcV12oshPSTwibQYDiHWgNf',
  'solstice:privileged2': '7SvWV1JurXkVTgD7HpjhbavsCUeZ99mDfwcUPjVHzM3q',
  'solstice:privileged3': '4RbkBoZUb9cXyEdL99NjFjeYZNJZjNa733Kjk6hTbB5d',
  'solstice:privileged4': '3RCVxiCnBfV2gtG7E7yEA36szGVCp122ynR8t8jGFhL5',
  'solstice:privileged5': 'Gfu8e2MwU4V7P3QHx9Do8XoWkHHyZDXUUc4qVYH6pyJ3',
  'solstice:decl0': 'AJzaqgoLHX8MD1vxTSfxjoo4UEA6fZse2QYTSybRcQKR',
  'solstice:decl1': '5sUPi9eLgb53551j9H3GompKQ1dXkHNeAQDJATyLSh6x',
  'solstice:decl2': 'BHSVJGGLH7wXg8SjkGRhuYcnEEoWbPnwy91EU8VvyzVW',
  'solstice:decl3': 'Az9femwrEysJHS5FvqUevP2vHpevAZqSdDHQbghGy3tx',
  'solstice:decl-program': 'CUzCJFHheptnMr2jC9Gh3rdb8dyQchtBFmiPbgC86cjx',
  'kestrel:protocol': 'NhPv3wtexiNsh2AjSd9gSHdWxkGBawtpW9jTx83wNqv',
  'kestrel:protocol_id': '6dCJLTWJTpdhSj8DQgjoJuy5wmzLVJTn2gQSB2XyB7wC',
  'kestrel:authority': 'BDcfUw6RakhbmVJkR5yac7yd8k13Xqy6fjNiMs5jAEVf',
  'kestrel:treasury': '95QY8nRLDQGMDE3fgLVZYPCMwEdYeZVTy4AxYyr1ZgiE',
  'kestrel:pool': 'BGDfmh3YGjUmTp8mZ5u6Pg59h5mdJnmzZQe22ZhEXhTs',
  'kestrel:vault': '244LxYwUuFky5JZfqb8H249pwbVgPwtq88zEHVeFTKFM',
  'kestrel:policy': 'HzL2NVRCpgf6u7ppi8tjfbyaBoCSiBKaqRcpxFmMw2N6',
  'kestrel:privileged1': '65ZytyxYyLS8gp7Lmw5afERYKRvhdKHR5posYYKeRrDq',
  'kestrel:privileged2': '6FoMUQYWAEEWJyJ3X3QxnJYpiYgzhH3NkavFGm2kaT9g',
  'kestrel:privileged3': 'HQjWXSurfPAtUPC2g7m8WLG3DWvTv5oXMMonH5DHJqUg',
  'kestrel:privileged4': '3sohJSgFXRc2tN4tdngZRiHGJRgLmSTnAvv5jmcwLRn9',
  'kestrel:privileged5': '2E3HfRq8ELZKVDrrh6yyGxUp5uQnfnmkp8fZvch4HjEK',
  'kestrel:decl0': 'BdNQrYhS6NnKLkPhaKWq5jeqRwUTEWpWLx1gDy1DEaWi',
  'kestrel:decl1': 'AXvu3RXmNL2DhNXdUVkiBMpwcAnzgb9vWGMb529z5FHV',
  'kestrel:decl2': 'DDV63arEsJwKNxKd6aSLcxWFHf9jhm973ztVurKfSqYg',
  'kestrel:decl3': '9WUy9z5pLCQqP4Yktf16Ng3FYieJG6c8Tz6dzNZiwYiN',
  'kestrel:decl-program': 'HooJ75KWH72Qj8HCjfUksRyyBUsUb3gEHKpuEYa9FniU',
  incident: '2t2L4JpzoRBNv7fp1TbLknNesAttDHcTmGAe8jjbHGzS',
  opener: '7whTeiZfL5Jc8GF9giTYWPbzsUVL86mum4wFq751Anwc',
  attestor1: '45Ep2U1pgMBDpopNwga2s7N4A3bQ9Mq9hW1b2h9XVPnH',
  attestor2: '52e2TqyqYEWAvoyHEWByk3jE6fCc7xgnhbjbiCnCNqjk',
  attestor3: 'ACXTKA4tJnFSX9TnVhnWxUWWMaCyKXLBtTJsh5ySFRi6',
  attestor4: '3cxiF59ZsbkD48ZCuqGJFkBXUXYafUN6KtVEu76Cbgj1',
  attestor5: 'DQRQNmJwRXsUxdC2XvwJ3ayeviTJuspQk9EkQ64WChAP',
  attestor6: 'AC8U7AGMHKQzkuRZH6edXdkbbWkkYu4JT4uBeYhNEeAU',
  attestor7: 'G6qenQYjeMUXZsJ3qVHcb9PWyMquFKgUCV1f6Z1ad8PK',
  attestation1: 'FKKLW47KwLoy4F8944NVXuJbhEVvJCPE3ro5od3HV1NH',
  attestation2: 'J6Zznv1nWeU9JnLtYwo7jhRySaah7ujNGbmnEzyshGnq',
  attestation3: '79ZaKXhqxD5Kc9s4f5mXwaAWjWR4fvuVmR2GvheyBxtw',
  attestation4: '81CKBacbgtuWAUqugT1PPDUfS9Fv8veeQKrTnHY9y2Zv',
  attestation5: 'CBT3n1fGx1yQTXzue9jajqFY5xh2gs5RcpR3gwDf9eU1',
  attestation6: 'Dgq3iBtgdhSJo9KdyF6Shtk55KYHSH1yndaViya4DLrU',
  attestation7: 'GKiYtT44Lf5jUzCjPHidrq95ynwWH4BYUQP4pCxrmUNs',
  'sig:trigger':
    '4Ua1znniuRBWLRUnrm2AP38cCnitDNYA12NusQa6PshAcHRjje84HxbboYTWhSi2FqbhcstoAwuBWqaLn8X8sgwm',
  'sig:opened':
    '4v5EuWSP5dMhHmdT88ScSyQqkZo4PYTXgTWUdY4Yz8xXgz1usHng1nY1kcn3yw45pP34dnJM5Gvy1dp7FkbxmDQf',
  'sig:attest1':
    'ShGX8A6bLx1uUkzzzuC2FCE2BJ7BATwRgHmeNXzShey3pJio2Ao7ydhjAEBqkk4RZuDpJfnDKFkefze3UQhvR38',
  'sig:attest2':
    'jjD1RZ5gN52PLUD2GqkLr56MGoVFw7kqqLstFucJpXgHSti9zFNRHpS7wNkJrAGWKc9RsT4NyDpc1zy6qKCaWXX',
  'sig:attest3':
    'SDtUiF17k572gTdEipJ7Fjt6WQqY7qmL3E8DuZKnXVCJnHx9JDtAhN2fSg4LA3eGp5Sdbock8C4qkuDfcyfSYuG',
  'sig:attest4':
    '4pYYxyzKS2xbu3yH7bRuYDhJ7uRFZ4hgqwDk5j2YiuUWkCHxRjn4sAWm4DDcwaVmeMbktGfdoCDJBqXwiVTbVaoM',
  'sig:attest5':
    '5qppBQWBjo8VBXsHwWLd1mnnKAvnwRKkSXvddE3AbvBKjHXqsUgrbHV12wx3mFcFerVYHzTudHzpGHFMu6wkYejH',
  'sig:attest6':
    '28nw2wJCqHW3KVGJFshHW8uApPESU1ha57ck9jDkvWXCUVVjpR2E1wryKwea4bs5k7jbhXEQmBss1J282ySHa3NH',
  'sig:attest7':
    '2oU4rXHNS5AxraaicSNxDuYhadVuAyqmSv9ovj3sUt5LEnLVXjr2X6ctiZe7wLbFHgGhZVKKo15i9tnVRj3bi9Ea',
  'sig:resolve':
    '3KHnooQ2uxt2oh6gZQg2Lg2WvFXPRhpgAZVAWFBaCc6vmWpPjVrDTKqCrYyKcR6t9akDxNobbaDiGQA1azpDTdxP',
} as const

type Label = keyof typeof K
const key = (label: Label): string => K[label]

const DECIMALS = 6
/** Whole dollars to base units, as the contract carries them. */
const usd = (dollars: number): string => (BigInt(dollars) * 10n ** BigInt(DECIMALS)).toString()
const utc = (text: string): number => Date.parse(`${text.replace(' ', 'T')}Z`) / 1000

const DAY = 86_400

/**
 * The one moment every response describes: a few minutes after the incident below was
 * paid. A pool read at one moment and an incident at another would contradict each
 * other — the pool still holding the capital the incident says it paid out.
 */
const AS_OF: AsOf = { slot: 412_882_900, unix_ts: utc('2026-08-11 09:20:00') }

export const CONFIG: ConfigResponse = {
  as_of: AS_OF,
  program_id: key('program'),
  admin: key('admin'),
  asset_mint: key('mint'),
  asset_decimals: DECIMALS,
  declaration_delay: DAY,
  attest_window: 300,
  withdraw_delay: 7 * DAY,
  quorum_bps: 6_000,
  attestor_count: 7,
  open_bond: usd(500),
  paused: false,
}

// ── Protocols ─────────────────────────────────────────────────────────────────

type Slug = 'meridian' | 'solstice' | 'kestrel'

interface PolicyTerms {
  limit: number
  retention: number
  premium: number
  start: string
  end: string
}

interface DeclarationTerms {
  name: string | null
  discriminator: string
  notBefore: string
  notAfter: string | null
  movesFunds: boolean
  submitted: string
}

interface ProtocolTerms {
  capital: number
  policy: PolicyTerms | null
  declarations: DeclarationTerms[]
}

const TERMS: Record<Slug, ProtocolTerms> = {
  meridian: {
    capital: 4_200_000,
    policy: {
      limit: 3_000_000,
      retention: 600_000,
      premium: 42_000,
      start: '2026-06-01 00:00:00',
      end: '2026-12-31 00:00:00',
    },
    declarations: [
      {
        name: 'update_funding_params',
        discriminator: '1f0a6c3e9b2d4417',
        notBefore: '2026-07-16 00:00:00',
        notAfter: null,
        movesFunds: false,
        submitted: '2026-07-14 10:00:00',
      },
      {
        name: 'add_collateral_market',
        discriminator: '8c41d2e07fa35b90',
        notBefore: '2026-08-02 00:00:00',
        notAfter: '2026-08-02 06:00:00',
        movesFunds: true,
        submitted: '2026-07-30 12:00:00',
      },
      {
        name: 'rotate_oracle_authority',
        discriminator: '53b7e9a1c4d80f26',
        notBefore: '2026-08-13 01:00:00',
        notAfter: '2026-08-13 03:00:00',
        movesFunds: true,
        submitted: '2026-08-10 12:00:00',
      },
    ],
  },
  solstice: {
    capital: 1_150_000,
    policy: {
      limit: 750_000,
      retention: 112_500,
      premium: 9_000,
      start: '2026-06-01 00:00:00',
      end: '2026-11-30 00:00:00',
    },
    declarations: [
      {
        name: 'set_reserve_factor',
        discriminator: 'a2c5e8f1b4d70369',
        notBefore: '2026-06-24 00:00:00',
        notAfter: null,
        movesFunds: false,
        submitted: '2026-06-22 09:00:00',
      },
      {
        name: 'init_lending_market',
        discriminator: '6e19b3d7f0a2c485',
        notBefore: '2026-08-18 03:00:00',
        notAfter: '2026-08-18 05:00:00',
        movesFunds: true,
        submitted: '2026-08-05 15:00:00',
      },
      {
        // A program without an on-chain IDL: the contract leaves the name out rather
        // than have us guess it.
        name: null,
        discriminator: '0d4f8a2b6e1c9573',
        notBefore: '2026-05-04 00:00:00',
        notAfter: null,
        movesFunds: false,
        submitted: '2026-05-02 08:00:00',
      },
    ],
  },
  kestrel: {
    capital: 380_000,
    policy: null,
    declarations: [
      {
        name: 'set_strategy_weights',
        discriminator: 'f3a8c1e5d9b24760',
        notBefore: '2026-07-30 00:00:00',
        notAfter: '2026-10-30 00:00:00',
        movesFunds: false,
        submitted: '2026-07-28 11:00:00',
      },
    ],
  },
}

const policyFor = (slug: Slug, terms: PolicyTerms, asOf: AsOf): Policy => {
  const limit = BigInt(usd(terms.limit))
  const retention = BigInt(usd(terms.retention))
  const start = utc(terms.start)
  const end = utc(terms.end)
  return {
    address: key(`${slug}:policy`),
    seq: 0,
    limit: limit.toString(),
    retention: retention.toString(),
    remaining_limit: limit.toString(),
    payable: payable(limit, retention).toString(),
    start_ts: start,
    end_ts: end,
    premium_paid: usd(terms.premium),
    beneficiary: key(`${slug}:treasury`),
    status: 'active',
    in_force: asOf.unix_ts >= start && asOf.unix_ts < end,
  }
}

const declarationFor = (
  slug: Slug,
  seq: number,
  terms: DeclarationTerms,
  asOf: AsOf,
): DeclarationEntryResponse => {
  const submittedAt = utc(terms.submitted)
  const raw = {
    programId: key(`${slug}:decl-program`),
    ixDiscriminator: [...terms.discriminator.matchAll(/../g)].map(([pair]) =>
      Number.parseInt(pair, 16),
    ),
    notBefore: utc(terms.notBefore),
    notAfter: terms.notAfter === null ? null : utc(terms.notAfter),
    movesFunds: terms.movesFunds,
    submittedAt,
    effectiveAt: submittedAt + CONFIG.declaration_delay,
    revokedAt: null,
  }
  return {
    address: key(`${slug}:decl${seq}` as Label),
    seq,
    program_id: raw.programId,
    ix_discriminator: terms.discriminator,
    instruction: terms.name === null ? null : { name: terms.name, source: 'anchor-idl' },
    not_before: raw.notBefore,
    not_after: raw.notAfter,
    moves_funds: raw.movesFunds,
    submitted_at: raw.submittedAt,
    effective_at: raw.effectiveAt,
    revoked_at: raw.revokedAt,
    state: entryStateAt(raw, asOf.unix_ts),
  }
}

const summaryFor = (slug: Slug, terms: ProtocolTerms, policies: Policy[]): PoolSummary => {
  const totalAssets = BigInt(usd(terms.capital))
  const locked = policies.reduce((sum, p) => sum + BigInt(p.remaining_limit), 0n)
  return {
    protocol: key(`${slug}:protocol`),
    pool: key(`${slug}:pool`),
    total_assets: totalAssets.toString(),
    total_shares: totalAssets.toString(),
    locked_limit: locked.toString(),
    utilization_bps: utilizationBps(locked, totalAssets),
    open_incidents: 0,
    policies_in_force: policies.filter((p) => p.in_force).length,
  }
}

const SLUGS: Slug[] = ['meridian', 'solstice', 'kestrel']

const declarationsAt = (slug: Slug, asOf: AsOf): DeclarationEntryResponse[] =>
  TERMS[slug].declarations.map((terms, seq) => declarationFor(slug, seq, terms, asOf))

/** Fixtures are data we wrote; a missing piece is a bug in this file, said loudly. */
const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === undefined || value === null) throw new Error(`fixtures: ${what} is missing`)
  return value
}

// ── The incident ──────────────────────────────────────────────────────────────

const TRIGGER_AT = utc('2026-08-11 09:14:02')
const OPENED_AT = TRIGGER_AT + 4

/** Seconds after the trigger, attestor number, verdict — in the order they landed. */
const VOTES: [number, number, 'unauthorized' | 'authorized'][] = [
  [9, 2, 'unauthorized'],
  [12, 5, 'unauthorized'],
  [15, 1, 'authorized'],
  [18, 3, 'unauthorized'],
  [20, 7, 'unauthorized'],
  [22, 4, 'unauthorized'],
]

/** Meridian's policy as it was issued, before the incident paid against it. */
const ISSUED = policyFor('meridian', must(TERMS.meridian.policy, 'meridian policy'), AS_OF)

/** `settle_payout`: the whole payable amount — the pool holds far more than it. */
const PAID = BigInt(ISSUED.payable)

const INCIDENT_SUMMARY: IncidentSummary = {
  address: key('incident'),
  protocol: key('meridian:protocol'),
  policy: ISSUED.address,
  trigger_signature: key('sig:trigger'),
  opener: key('opener'),
  bond: CONFIG.open_bond,
  opened_at: OPENED_AT,
  deadline: OPENED_AT + CONFIG.attest_window,
  set_size: CONFIG.attestor_count,
  quorum_needed: quorumNeeded(CONFIG.attestor_count, CONFIG.quorum_bps),
  votes_unauthorized: VOTES.filter(([, , verdict]) => verdict === 'unauthorized').length,
  votes_authorized: VOTES.filter(([, , verdict]) => verdict === 'authorized').length,
  status: 'paid_out',
  payout: PAID.toString(),
  shortfall: '0',
}

/** The seven attestors of the set, by number. */
export const ATTESTOR_KEYS: string[] = [1, 2, 3, 4, 5, 6, 7].map((i) =>
  key(`attestor${i}` as Label),
)

/** The vote that carried the quorum. */
const QUORUM_VOTE = must(VOTES.at(-1), 'the deciding vote')

/**
 * `resolve` is its own transaction: permissionless, sent by the attestor whose vote
 * completed the quorum right after it lands (`apps/attestor/src/act.ts`). On devnet the
 * gap is two to three seconds.
 */
const RESOLVED_AT = TRIGGER_AT + QUORUM_VOTE[0] + 2

export const INCIDENT_DETAIL: IncidentDetailResponse = {
  as_of: AS_OF,
  incident: INCIDENT_SUMMARY,
  trigger: { signature: key('sig:trigger'), slot: 412_882_035, block_time: TRIGGER_AT },
  opened: { signature: key('sig:opened'), at: OPENED_AT },
  attestations: VOTES.map(([t, n, verdict]) => ({
    attestor: key(`attestor${n}` as Label),
    attestation: key(`attestation${n}` as Label),
    verdict,
    submitted_at: TRIGGER_AT + t,
    signature: key(`sig:attest${n}` as Label),
  })),
  payout: {
    signature: key('sig:resolve'),
    amount: PAID.toString(),
    beneficiary: ISSUED.beneficiary,
    at: RESOLVED_AT,
  },
  verification: {
    program_id: CONFIG.program_id,
    accounts: {
      config: key('config'),
      protocol: key('meridian:protocol'),
      pool: key('meridian:pool'),
      policy: ISSUED.address,
      incident: key('incident'),
      vault: key('meridian:vault'),
    },
    declaration_at_trigger: {
      evaluated_at: TRIGGER_AT,
      entries: declarationsAt('meridian', { slot: 412_882_035, unix_ts: TRIGGER_AT }),
    },
  },
}

// ── Pools, after the incident ─────────────────────────────────────────────────

/**
 * What `resolve` leaves of a pool and a policy it paid from (`instructions/resolve.rs`):
 * capital and reservation fall by the payout, and a policy with nothing left payable is
 * exhausted and releases the retention it still reserved.
 */
const settle = (pool: PoolSummary, policy: Policy, paid: bigint) => {
  const remaining = BigInt(policy.remaining_limit) - paid
  const left = payable(remaining, BigInt(policy.retention))
  const exhausted = left === 0n
  const total = BigInt(pool.total_assets) - paid
  const locked = BigInt(pool.locked_limit) - paid - (exhausted ? remaining : 0n)
  return {
    pool: {
      ...pool,
      total_assets: total.toString(),
      locked_limit: locked.toString(),
      utilization_bps: utilizationBps(locked, total),
      policies_in_force: pool.policies_in_force - (exhausted && policy.in_force ? 1 : 0),
    },
    policy: {
      ...policy,
      remaining_limit: remaining.toString(),
      payable: left.toString(),
      status: exhausted ? ('exhausted' as const) : policy.status,
      in_force: policy.in_force && !exhausted,
    },
  }
}

const detailFor = (slug: Slug): ProtocolDetailResponse => {
  const terms = TERMS[slug]
  const issued = terms.policy === null ? [] : [policyFor(slug, terms.policy, AS_OF)]
  const before = summaryFor(slug, terms, issued)
  const hit = slug === 'meridian'
  const after = hit ? settle(before, must(issued[0], 'meridian policy'), PAID) : null
  const policies = after === null ? issued : [after.policy]
  return {
    as_of: AS_OF,
    protocol: {
      address: key(`${slug}:protocol`),
      protocol_id: key(`${slug}:protocol_id`),
      authority: key(`${slug}:authority`),
      treasury: key(`${slug}:treasury`),
      privileged: [1, 2, 3, 4, 5].map((i) => key(`${slug}:privileged${i}` as Label)),
      new_policies_paused: false,
      incident_count: hit ? 1 : 0,
    },
    pool: after?.pool ?? before,
    // As the API lists them: only policies still holding a reservation.
    policies: policies.filter((p) => p.status === 'pending' || p.status === 'active'),
    recent_incidents: hit ? [INCIDENT_SUMMARY] : [],
  }
}

export const PROTOCOL_DETAILS: ProtocolDetailResponse[] = SLUGS.map(detailFor)

export const POOLS: PoolsResponse = {
  as_of: AS_OF,
  pools: PROTOCOL_DETAILS.map((detail) => detail.pool),
}

export const DECLARATIONS: DeclarationsResponse[] = SLUGS.map((slug) => ({
  as_of: AS_OF,
  protocol: key(`${slug}:protocol`),
  entries: declarationsAt(slug, AS_OF),
}))
