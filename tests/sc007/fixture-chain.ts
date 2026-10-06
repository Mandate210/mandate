// The chain behind the demo trail (T056): what an RPC would answer if the incident in
// `apps/web/src/lib/fixtures.ts` had really happened.
//
// The fixture trail is what the site shows without an API, and SC-007 holds it to the
// same standard as a real one: a visitor replaying it must reach the decision it
// claims. So the accounts here are encoded with the program's own Borsh layout and
// served in the shapes an RPC uses, and the replay decodes them exactly as it decodes
// devnet — nothing in `replay.ts` knows it is looking at a fixture.
//
// Built from the fixture's stored fields only. What the trail *derives* — entry states,
// the quorum needed, what the policy owed — is not copied in here; that is what the
// replay recomputes and compares.
//
// The trigger is the one piece the API never carries, so it is written here: an
// authority of meridian running `rotate_oracle_authority` at 09:14:02, while the entry
// declaring it was submitted the day before and is still in its delay (FR-031).

import { createHash } from 'node:crypto'
import { BN, BorshCoder, type Idl, utils } from '@coral-xyz/anchor'
import { DRAIN_COVER_IDL, type JsonRpc, findVault } from '@mandate/sdk'
import type { DeclarationEntryResponse, IncidentDetailResponse } from '@mandate/shared'
import { PublicKey } from '@solana/web3.js'
import {
  CONFIG,
  DECLARATIONS,
  INCIDENT_DETAIL,
  INCIDENT_POLICY,
  PROTOCOL_DETAILS,
} from '../../apps/web/src/lib/fixtures'

const coder = new BorshCoder(DRAIN_COVER_IDL as unknown as Idl)

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const pubkey = (address: string): PublicKey => new PublicKey(address)
const bn = (value: string | number): BN => new BN(value.toString())
const pascal = (snake: string): string =>
  snake.replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase())
const enumOf = (name: string): Record<string, Record<string, never>> => ({ [pascal(name)]: {} })
/** An address nobody holds, named after what it stands for. */
const mock = (label: string): string =>
  new PublicKey(createHash('sha256').update(`mandate-mock:${label}`).digest()).toBase58()
const base58 = (bytes: readonly number[]): string => utils.bytes.bs58.encode(Uint8Array.from(bytes))
const hexBytes = (hex: string): number[] =>
  [...hex.matchAll(/../g)].map(([pair]) => Number.parseInt(pair, 16))

export interface FixtureChain {
  /** A copy of the trail, free to tamper with. */
  trail: IncidentDetailResponse
  accounts: Map<string, { owner: string; data: Buffer }>
  transactions: Map<string, unknown>
  rpc: JsonRpc
  /** Decodes an account, lets `change` edit its fields, and encodes it back. */
  patch: (
    address: string,
    kind: string,
    change: (fields: Record<string, unknown>) => void,
  ) => Promise<void>
}

export const fixtureChain = async (): Promise<FixtureChain> => {
  const trail = structuredClone(INCIDENT_DETAIL)
  const { verification, incident } = trail
  const program = verification.program_id
  const { accounts: at } = verification
  const detail = PROTOCOL_DETAILS.find((d) => d.protocol.address === at.protocol)
  const declarations = DECLARATIONS.find((d) => d.protocol === at.protocol)
  if (detail === undefined || declarations === undefined) throw new Error('fixtures: no meridian')
  const payout = trail.payout
  if (payout === null) throw new Error('fixtures: the incident was meant to be paid')

  const accounts = new Map<string, { owner: string; data: Buffer }>()
  const put = async (address: string, kind: string, fields: object) => {
    accounts.set(address, { owner: program, data: await coder.accounts.encode(kind, fields) })
  }

  await put(at.config, 'Config', {
    admin: pubkey(CONFIG.admin),
    asset_mint: pubkey(CONFIG.asset_mint),
    declaration_delay: bn(CONFIG.declaration_delay),
    attest_window: bn(CONFIG.attest_window),
    withdraw_delay: bn(CONFIG.withdraw_delay),
    quorum_bps: CONFIG.quorum_bps,
    attestor_count: CONFIG.attestor_count,
    open_bond: bn(CONFIG.open_bond),
    paused: CONFIG.paused,
  })
  await put(at.protocol, 'Protocol', {
    authority: pubkey(detail.protocol.authority),
    treasury: pubkey(detail.protocol.treasury),
    privileged: detail.protocol.privileged.map(pubkey),
    pool: pubkey(at.pool),
    new_policies_paused: detail.protocol.new_policies_paused,
    next_policy_seq: bn(1),
    next_declaration_seq: bn(declarations.entries.length),
    incident_count: bn(detail.protocol.incident_count),
  })
  await put(at.pool, 'Pool', {
    vault: pubkey(at.vault),
    total_assets: bn(detail.pool.total_assets),
    total_shares: bn(detail.pool.total_shares),
    locked_limit: bn(detail.pool.locked_limit),
    open_incidents: detail.pool.open_incidents,
    bump: 255,
  })
  await put(at.policy, 'Policy', {
    limit: bn(INCIDENT_POLICY.limit),
    retention: bn(INCIDENT_POLICY.retention),
    remaining_limit: bn(INCIDENT_POLICY.remaining_limit),
    start_ts: bn(INCIDENT_POLICY.start_ts),
    end_ts: bn(INCIDENT_POLICY.end_ts),
    premium_paid: bn(INCIDENT_POLICY.premium_paid),
    beneficiary: pubkey(INCIDENT_POLICY.beneficiary),
    status: enumOf(INCIDENT_POLICY.status),
  })
  // Every entry as the chain holds it now — including any submitted after the trigger,
  // which the replay has to leave out by itself.
  for (const entry of declarations.entries)
    await put(entry.address, 'DeclarationEntry', entryFields(entry))
  await put(at.incident, 'Incident', {
    policy: pubkey(incident.policy),
    trigger_sig: utils.bytes.bs58.decode(incident.trigger_signature),
    opener: pubkey(incident.opener),
    bond: bn(incident.bond),
    opened_at: bn(incident.opened_at),
    opened_epoch: bn(0),
    deadline: bn(incident.deadline),
    set_size: incident.set_size,
    votes_unauthorized: incident.votes_unauthorized,
    votes_authorized: incident.votes_authorized,
    status: enumOf(incident.status),
    payout: bn(incident.payout),
    shortfall: bn(incident.shortfall),
  })
  for (const attestation of trail.attestations) {
    await put(attestation.attestation, 'Attestation', {
      verdict: enumOf(attestation.verdict),
      submitted_at: bn(attestation.submitted_at),
    })
  }

  const transactions = new Map<string, unknown>()

  const [, rotateOracleAuthority] = must(
    declarations.entries
      .map((e) => [e.instruction?.name, e] as const)
      .find(([name]) => name === 'rotate_oracle_authority'),
    'the rotate_oracle_authority entry',
  )
  const authority = must(detail.protocol.privileged[0], 'a privileged address')
  transactions.set(
    trail.trigger.signature,
    rpcTransaction({
      slot: must(trail.trigger.slot, 'trigger slot'),
      blockTime: must(trail.trigger.block_time, 'trigger block time'),
      keys: [authority, mock('meridian:oracle'), rotateOracleAuthority.program_id],
      signers: 1,
      instructions: [
        {
          programIdIndex: 2,
          accounts: [0, 1],
          // The new oracle authority follows the discriminator — arguments the rule never reads.
          data: [
            ...hexBytes(rotateOracleAuthority.ix_discriminator),
            ...new Array<number>(32).fill(7),
          ],
        },
      ],
    }),
  )

  // `resolve`, sent by the attestor whose vote completed the quorum.
  const decider = must(trail.attestations.at(-1), 'the deciding attestation').attestor
  const beneficiaryToken = findVault(
    pubkey(CONFIG.asset_mint),
    pubkey(payout.beneficiary),
  ).toBase58()
  const resolve = must(
    (DRAIN_COVER_IDL as unknown as Idl).instructions.find((ix) => ix.name === 'resolve'),
    'resolve in the IDL',
  ).discriminator
  transactions.set(
    payout.signature,
    rpcTransaction({
      slot: must(trail.trigger.slot, 'trigger slot') + 60,
      blockTime: payout.at,
      keys: [
        decider,
        at.config,
        at.protocol,
        at.pool,
        at.policy,
        at.incident,
        at.vault,
        beneficiaryToken,
        mock('opener:token'),
        TOKEN_PROGRAM,
        program,
      ],
      signers: 1,
      instructions: [
        { programIdIndex: 10, accounts: [1, 2, 3, 4, 5, 6, 7, 8, 9], data: [...resolve] },
      ],
      tokenBalances: {
        pre: [{ accountIndex: 7, mint: CONFIG.asset_mint, owner: payout.beneficiary, amount: '0' }],
        post: [
          {
            accountIndex: 7,
            mint: CONFIG.asset_mint,
            owner: payout.beneficiary,
            amount: payout.amount,
          },
        ],
      },
    }),
  )

  const rpc: JsonRpc = async (method, params) => {
    const [first, options] = params as [
      string,
      { filters?: { memcmp: { offset: number; bytes: string } }[] },
    ]
    if (method === 'getAccountInfo') {
      const found = accounts.get(first)
      return {
        context: { slot: 0 },
        value:
          found === undefined
            ? null
            : {
                data: [found.data.toString('base64'), 'base64'],
                owner: found.owner,
                executable: false,
                lamports: 1,
                rentEpoch: 0,
                space: found.data.length,
              },
      }
    }
    if (method === 'getTransaction') return transactions.get(first) ?? null
    if (method === 'getProgramAccounts') {
      const filters = options.filters ?? []
      return [...accounts]
        .filter(([, { owner }]) => owner === first)
        .filter(([, { data }]) =>
          filters.every(({ memcmp }) => {
            const needle = Buffer.from(utils.bytes.bs58.decode(memcmp.bytes))
            return data.subarray(memcmp.offset, memcmp.offset + needle.length).equals(needle)
          }),
        )
        .map(([address, { owner, data }]) => ({
          pubkey: address,
          account: {
            data: [data.toString('base64'), 'base64'],
            owner,
            executable: false,
            lamports: 1,
            rentEpoch: 0,
            space: data.length,
          },
        }))
    }
    throw new Error(`the fixture chain does not answer ${method}`)
  }

  const patch: FixtureChain['patch'] = async (address, kind, change) => {
    const found = accounts.get(address)
    if (found === undefined) throw new Error(`no account ${address}`)
    const fields = coder.accounts.decode(kind, found.data) as Record<string, unknown>
    change(fields)
    accounts.set(address, { owner: found.owner, data: await coder.accounts.encode(kind, fields) })
  }

  return { trail, accounts, transactions, rpc, patch }
}

const entryFields = (entry: DeclarationEntryResponse) => ({
  program_id: pubkey(entry.program_id),
  ix_discriminator: hexBytes(entry.ix_discriminator),
  not_before: bn(entry.not_before),
  not_after: entry.not_after === null ? null : bn(entry.not_after),
  moves_funds: entry.moves_funds,
  submitted_at: bn(entry.submitted_at),
  effective_at: bn(entry.effective_at),
  revoked_at: entry.revoked_at === null ? null : bn(entry.revoked_at),
})

interface TokenBalance {
  accountIndex: number
  mint: string
  owner: string
  amount: string
}

/** A `getTransaction` answer in `encoding: 'json'`, legacy message, as a node gives it. */
const rpcTransaction = ({
  slot,
  blockTime,
  keys,
  signers,
  instructions,
  tokenBalances = { pre: [], post: [] },
}: {
  slot: number
  blockTime: number
  keys: string[]
  signers: number
  instructions: { programIdIndex: number; accounts: number[]; data: number[] }[]
  tokenBalances?: { pre: TokenBalance[]; post: TokenBalance[] }
}) => {
  const balances = (list: TokenBalance[]) =>
    list.map(({ amount, ...rest }) => ({
      ...rest,
      uiTokenAmount: { amount, decimals: CONFIG.asset_decimals },
    }))
  return {
    slot,
    blockTime,
    version: 'legacy',
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: balances(tokenBalances.pre),
      postTokenBalances: balances(tokenBalances.post),
    },
    transaction: {
      signatures: [],
      message: {
        header: {
          numRequiredSignatures: signers,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        accountKeys: keys,
        recentBlockhash: base58(new Array<number>(32).fill(1)),
        instructions: instructions.map((ix) => ({
          ...ix,
          data: base58(ix.data),
          stackHeight: null,
        })),
      },
    },
  }
}

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === undefined || value === null) throw new Error(`fixture chain: ${what} is missing`)
  return value
}
