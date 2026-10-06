import { BN, BorshCoder, type Idl } from '@coral-xyz/anchor'
import type { ObservedTransaction } from '@mandate/shared'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { DRAIN_COVER_IDL } from './idl'
import { EVENT_IX_TAG, LEGACY_RESOLVE, settlementsIn } from './settlement'

const coder = new BorshCoder(DRAIN_COVER_IDL as unknown as Idl)
const program = Keypair.generate().publicKey
const incident = Keypair.generate().publicKey
const other = Keypair.generate().publicKey.toBase58()

const event = (status: string, payout: number) => {
  const found = (DRAIN_COVER_IDL as unknown as Idl).events?.find(
    (e) => e.name === 'IncidentSettled',
  )
  if (found === undefined) throw new Error('IncidentSettled is not in the IDL')
  return [
    ...EVENT_IX_TAG,
    ...found.discriminator,
    ...coder.types.encode('IncidentSettled', {
      incident,
      status: { [status]: {} },
      payout: new BN(payout),
      shortfall: new BN(0),
      bond_returned: new BN(7),
    }),
  ]
}

const transaction = (
  instructions: { programId: string; data: number[]; accounts?: string[] }[],
): ObservedTransaction => ({
  signature: 'sig',
  blockTime: 1,
  signers: [],
  accountKeys: [],
  instructions: instructions.map((ix) => ({ accounts: [], ...ix, stackHeight: 2 })),
})

describe('settlementsIn', () => {
  it('reads the decision the deciding vote states', () => {
    expect(
      settlementsIn(
        program,
        transaction([{ programId: program.toBase58(), data: event('PaidOut', 950) }]),
      ),
    ).toEqual([
      {
        incident: incident.toBase58(),
        status: 'paid_out',
        payout: '950',
        shortfall: '0',
        via: 'attest',
      },
    ])
  })

  it('reads a close on a policy out of force as what it is (FR-016)', () => {
    expect(
      settlementsIn(
        program,
        transaction([{ programId: program.toBase58(), data: event('ClosedNoPayout', 0) }]),
      ),
    ).toMatchObject([{ status: 'closed_no_payout', payout: '0' }])
  })

  // Paid before T078: the instruction is gone from the IDL, its trace is not.
  it('still recognises a resolve from before the upgrade', () => {
    const accounts = [other, other, other, other, incident.toBase58()]
    expect(
      settlementsIn(
        program,
        transaction([
          { programId: program.toBase58(), data: [...LEGACY_RESOLVE.discriminator], accounts },
        ]),
      ),
    ).toEqual([
      {
        incident: incident.toBase58(),
        status: 'paid_out',
        payout: null,
        shortfall: null,
        via: 'resolve',
      },
    ])
  })

  it('takes nothing from another program, whatever its bytes', () => {
    expect(
      settlementsIn(
        program,
        transaction([
          { programId: other, data: event('PaidOut', 950) },
          {
            programId: other,
            data: [...LEGACY_RESOLVE.discriminator],
            accounts: [other, other, other, other, other],
          },
        ]),
      ),
    ).toEqual([])
  })

  // Every attestation is an `attest`; only the event marks the one that decided.
  it('takes nothing from an ordinary vote', () => {
    const attest = (DRAIN_COVER_IDL as unknown as Idl).instructions.find(
      (ix) => ix.name === 'attest',
    )
    if (attest === undefined) throw new Error('attest is not in the IDL')
    expect(
      settlementsIn(
        program,
        transaction([{ programId: program.toBase58(), data: [...attest.discriminator, 0] }]),
      ),
    ).toEqual([])
  })

  it('does not mistake an instruction that merely starts like resolve for one', () => {
    expect(
      settlementsIn(
        program,
        transaction([
          {
            programId: program.toBase58(),
            data: [...LEGACY_RESOLVE.discriminator, 1],
            accounts: [other, other, other, other, other],
          },
        ]),
      ),
    ).toEqual([])
  })
})
