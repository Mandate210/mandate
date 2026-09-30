// A small world of the program's accounts, encoded byte for byte as the program would
// write them — for the indexer's tests only. Addresses are derived with the same seeds
// the program uses, so derivation in `accounts.ts` is tested against the real rule.

import { BN, BorshCoder, type Idl } from '@coral-xyz/anchor'
import {
  DRAIN_COVER_IDL,
  PROGRAM_ID,
  findAttestation,
  findAttestor,
  findConfig,
  findDeclarationEntry,
  findIncident,
  findPolicy,
  findPool,
  findProtocol,
} from '@mandate/sdk'
import type { ObservedTransaction } from '@mandate/shared'
import { Keypair, type PublicKey } from '@solana/web3.js'

const coder = new BorshCoder(DRAIN_COVER_IDL as unknown as Idl)

const fixedKey = (seed: number): PublicKey =>
  Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => seed)).publicKey

export const programId = PROGRAM_ID

export const keys = {
  admin: fixedKey(1),
  mint: fixedKey(2),
  protocolId: fixedKey(3),
  authority: fixedKey(4),
  treasury: fixedKey(5),
  privileged: fixedKey(6),
  vault: fixedKey(7),
  beneficiary: fixedKey(8),
  opener: fixedKey(9),
  attestorA: fixedKey(10),
  attestorB: fixedKey(11),
  declared: fixedKey(12),
}

export const TRIGGER_SIG = Uint8Array.from({ length: 64 }, (_, index) => index + 1)

export const addresses = {
  config: findConfig(programId),
  protocol: findProtocol(programId, keys.protocolId),
  pool: findPool(programId, findProtocol(programId, keys.protocolId)),
  policy0: findPolicy(programId, findProtocol(programId, keys.protocolId), 0),
  policy1: findPolicy(programId, findProtocol(programId, keys.protocolId), 1),
  declaration0: findDeclarationEntry(programId, findProtocol(programId, keys.protocolId), 0),
  incident: findIncident(programId, findProtocol(programId, keys.protocolId), TRIGGER_SIG),
  attestorA: findAttestor(programId, keys.attestorA),
  attestorB: findAttestor(programId, keys.attestorB),
}

export const attestationOf = (authority: PublicKey): PublicKey =>
  findAttestation(programId, addresses.incident, authority)

type Overrides = Record<string, unknown>

export const encode = (kind: string, fields: Overrides): Promise<Buffer> =>
  coder.accounts.encode(kind, fields)

export const fields = {
  config: (overrides: Overrides = {}) => ({
    admin: keys.admin,
    asset_mint: keys.mint,
    declaration_delay: new BN(30),
    attest_window: new BN(90),
    withdraw_delay: new BN(300),
    quorum_bps: 6000,
    attestor_count: 2,
    open_bond: new BN(1_000_000),
    paused: false,
    ...overrides,
  }),
  protocol: (overrides: Overrides = {}) => ({
    authority: keys.authority,
    treasury: keys.treasury,
    privileged: [keys.privileged],
    pool: addresses.pool,
    new_policies_paused: false,
    next_policy_seq: new BN(2),
    next_declaration_seq: new BN(1),
    incident_count: new BN(1),
    ...overrides,
  }),
  pool: (overrides: Overrides = {}) => ({
    vault: keys.vault,
    total_assets: new BN('18446744073709551615'),
    total_shares: new BN(1000),
    locked_limit: new BN(500),
    open_incidents: 0,
    bump: 255,
    ...overrides,
  }),
  policy: (overrides: Overrides = {}) => ({
    limit: new BN(10_000),
    retention: new BN(500),
    remaining_limit: new BN(500),
    start_ts: new BN(1_700_000_000),
    end_ts: new BN(1_800_000_000),
    premium_paid: new BN(100),
    beneficiary: keys.beneficiary,
    status: { Active: {} },
    ...overrides,
  }),
  declaration: (overrides: Overrides = {}) => ({
    program_id: keys.declared,
    ix_discriminator: [0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 1],
    not_before: new BN(1_700_000_000),
    not_after: null,
    moves_funds: true,
    submitted_at: new BN(1_699_999_000),
    effective_at: new BN(1_700_000_000),
    revoked_at: new BN(1_750_000_000),
    ...overrides,
  }),
  incident: (overrides: Overrides = {}) => ({
    policy: addresses.policy0,
    trigger_sig: [...TRIGGER_SIG],
    opener: keys.opener,
    bond: new BN(1_000_000),
    opened_at: new BN(1_710_000_000),
    opened_epoch: new BN(1171),
    deadline: new BN(1_710_000_090),
    set_size: 2,
    votes_unauthorized: 2,
    votes_authorized: 0,
    status: { PaidOut: {} },
    payout: new BN(9500),
    shortfall: new BN(0),
    ...overrides,
  }),
  attestation: (overrides: Overrides = {}) => ({
    verdict: { Unauthorized: {} },
    submitted_at: new BN(1_710_000_010),
    ...overrides,
  }),
  attestor: (authority: PublicKey) => ({
    authority,
    active_from_epoch: new BN(1171),
    in_set: true,
    stake: new BN(0),
    agreed: 0,
    disagreed: 0,
  }),
}

/** Every account of the world, as `getProgramAccounts` would return it. */
export const worldAccounts = async (): Promise<{ address: string; data: Buffer }[]> => [
  { address: addresses.config.toBase58(), data: await encode('Config', fields.config()) },
  { address: addresses.protocol.toBase58(), data: await encode('Protocol', fields.protocol()) },
  { address: addresses.pool.toBase58(), data: await encode('Pool', fields.pool()) },
  { address: addresses.policy0.toBase58(), data: await encode('Policy', fields.policy()) },
  {
    address: addresses.policy1.toBase58(),
    data: await encode('Policy', fields.policy({ status: { Pending: {} } })),
  },
  {
    address: addresses.declaration0.toBase58(),
    data: await encode('DeclarationEntry', fields.declaration()),
  },
  { address: addresses.incident.toBase58(), data: await encode('Incident', fields.incident()) },
  {
    address: addresses.attestorA.toBase58(),
    data: await encode('Attestor', fields.attestor(keys.attestorA)),
  },
  {
    address: addresses.attestorB.toBase58(),
    data: await encode('Attestor', fields.attestor(keys.attestorB)),
  },
  {
    address: attestationOf(keys.attestorA).toBase58(),
    data: await encode('Attestation', fields.attestation()),
  },
  {
    address: attestationOf(keys.attestorB).toBase58(),
    data: await encode('Attestation', fields.attestation({ verdict: { Authorized: {} } })),
  },
]

const IX_ACCOUNTS = new Map(
  (DRAIN_COVER_IDL as unknown as Idl).instructions.map((instruction) => [
    instruction.name,
    instruction.accounts.map((account) => account.name),
  ]),
)

/**
 * One instruction of this program, with its accounts given by the IDL's names — any
 * not given are filled with a stand-in, since the indexer reads only the named ones.
 */
export const instruction = (
  name: string,
  args: Overrides,
  accounts: Record<string, PublicKey>,
): ObservedTransaction['instructions'][number] => ({
  programId: programId.toBase58(),
  data: [...coder.instruction.encode(name, args)],
  accounts: (IX_ACCOUNTS.get(name) ?? []).map(
    (account) => accounts[account]?.toBase58() ?? keys.admin.toBase58(),
  ),
  stackHeight: 1,
})

export const transaction = (
  signature: string,
  instructions: ObservedTransaction['instructions'],
  blockTime = 1_710_000_050,
): ObservedTransaction => ({
  signature,
  blockTime,
  signers: [keys.admin.toBase58()],
  accountKeys: [],
  instructions,
})

export const registerTx = (signature = 'SigRegister') =>
  transaction(signature, [
    instruction(
      'register_protocol',
      {
        protocol_id: keys.protocolId,
        authority: keys.authority,
        treasury: keys.treasury,
        privileged: [keys.privileged],
      },
      { protocol: addresses.protocol, pool: addresses.pool },
    ),
  ])

export const openTx = (signature = 'SigOpen') =>
  transaction(signature, [
    instruction(
      'open_incident',
      { policy_seq: new BN(0), trigger_sig: [...TRIGGER_SIG] },
      {
        protocol: addresses.protocol,
        pool: addresses.pool,
        policy: addresses.policy0,
        incident: addresses.incident,
      },
    ),
  ])

export const attestTx = (authority: PublicKey, signature: string) =>
  transaction(signature, [
    instruction(
      'attest',
      { verdict: { Unauthorized: {} } },
      {
        protocol: addresses.protocol,
        incident: addresses.incident,
        attestor_authority: authority,
        attestor: findAttestor(programId, authority),
        attestation: attestationOf(authority),
      },
    ),
  ])

export const resolveTx = (signature = 'SigResolve', blockTime = 1_710_000_060) =>
  transaction(
    signature,
    [
      instruction(
        'resolve',
        {},
        {
          protocol: addresses.protocol,
          pool: addresses.pool,
          policy: addresses.policy0,
          incident: addresses.incident,
        },
      ),
    ],
    blockTime,
  )
