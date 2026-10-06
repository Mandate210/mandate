// Everything the CLI reads, it reads from the chain (T068).
//
// Not from our API: the database behind it is a cache that can lag (`docs/PLAN.md` →
// «Postgres — кеш»), and a protocol deciding whether to revoke an entry has to look at
// what attestors look at. The reads are the attestor's own (`apps/attestor/src/chain.ts`
// → `loadDeclaration`), with the sequence number kept, because that is what `narrow`
// and `revoke` address an entry by.

import {
  Program as AnchorProgram,
  AnchorProvider,
  BN,
  type Program,
  type Wallet,
} from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig, findDeclarationEntry } from '@mandate/sdk'
import type { DeclarationEntry } from '@mandate/shared'
import {
  type Connection,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  type Transaction,
  type TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js'
import { type Idl, idlSchema } from './operation'

/**
 * A wallet that can only say who it is. The program client wants one to exist, and
 * nothing it is used for here signs: the CLI signs with the authority's key itself, or
 * not at all.
 */
const readOnlyWallet = (publicKey: PublicKey): Wallet => {
  const refuse = <T extends Transaction | VersionedTransaction>(): Promise<T> =>
    Promise.reject(new Error('the program client does not sign here'))
  return {
    publicKey,
    signTransaction: refuse,
    signAllTransactions: refuse,
  } as unknown as Wallet
}

export const programFor = (connection: Connection): Program<DrainCover> =>
  createProgram(
    new AnchorProvider(connection, readOnlyWallet(PublicKey.default), { commitment: 'confirmed' }),
  )

/** The cluster's clock, the one `Clock::get` returns — not this machine's. */
export const clusterNow = async (connection: Connection): Promise<number> => {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
  if (clock === null) throw new Error('the Clock sysvar is missing — is this a Solana RPC?')
  // slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp: five
  // little-endian 64-bit fields, the last at offset 32.
  const view = new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength)
  return Number(view.getBigInt64(32, true))
}

export interface ProtocolView {
  readonly address: PublicKey
  readonly authority: PublicKey
  readonly nextSeq: number
}

export const readProtocol = async (
  program: Program<DrainCover>,
  address: PublicKey,
): Promise<ProtocolView> => {
  const account = await program.account.protocol.fetchNullable(address)
  if (account === null) {
    throw new Error(
      `${address.toBase58()} is not a protocol of program ${program.programId.toBase58()}`,
    )
  }
  return {
    address,
    authority: account.authority,
    nextSeq: account.nextDeclarationSeq.toNumber(),
  }
}

export const readDelay = async (program: Program<DrainCover>): Promise<number> =>
  (await program.account.config.fetch(findConfig(program.programId))).declarationDelay.toNumber()

export interface NumberedEntry {
  readonly seq: number
  readonly address: PublicKey
  readonly entry: DeclarationEntry
}

export const readEntries = async (
  program: Program<DrainCover>,
  protocol: ProtocolView,
): Promise<NumberedEntry[]> => {
  const addresses = Array.from({ length: protocol.nextSeq }, (_, seq) =>
    findDeclarationEntry(program.programId, protocol.address, seq),
  )
  const accounts = await program.account.declarationEntry.fetchMultiple(addresses)

  return accounts.flatMap((account, seq) => {
    const address = addresses[seq]
    if (account === null || address === undefined) return []
    return [
      {
        seq,
        address,
        entry: {
          programId: account.programId.toBase58(),
          ixDiscriminator: [...account.ixDiscriminator],
          notBefore: account.notBefore.toNumber(),
          notAfter: account.notAfter === null ? null : account.notAfter.toNumber(),
          movesFunds: account.movesFunds,
          submittedAt: account.submittedAt.toNumber(),
          effectiveAt: account.effectiveAt.toNumber(),
          revokedAt: account.revokedAt === null ? null : account.revokedAt.toNumber(),
        },
      },
    ]
  })
}

export const readEntry = async (
  program: Program<DrainCover>,
  protocol: ProtocolView,
  seq: number,
): Promise<NumberedEntry> => {
  const found = (await readEntries(program, protocol)).find((numbered) => numbered.seq === seq)
  if (found === undefined) throw new Error(`protocol has no declaration entry #${seq}`)
  return found
}

/** The IDL a program published with `anchor idl init`, or `null` if it published none. */
export const fetchIdl = async (
  connection: Connection,
  programId: PublicKey,
): Promise<Idl | null> => {
  const raw: unknown = await AnchorProgram.fetchIdl(
    programId,
    new AnchorProvider(connection, readOnlyWallet(PublicKey.default), {}),
  )
  return raw === null ? null : idlSchema.parse(raw)
}

export const submitInstruction = (
  program: Program<DrainCover>,
  protocol: ProtocolView,
  terms: {
    programId: string
    discriminator: number[]
    notBefore: number
    notAfter: number | null
    movesFunds: boolean
  },
): Promise<TransactionInstruction> =>
  program.methods
    .submitDeclaration(
      new PublicKey(terms.programId),
      terms.discriminator,
      new BN(terms.notBefore),
      terms.notAfter === null ? null : new BN(terms.notAfter),
      terms.movesFunds,
    )
    .accountsPartial({
      protocol: protocol.address,
      authority: protocol.authority,
      // The address is fixed by the sequence number as it stands now. If another entry
      // lands first, this one's seeds no longer match and the program refuses it —
      // nothing is overwritten.
      entry: findDeclarationEntry(program.programId, protocol.address, protocol.nextSeq),
      systemProgram: SystemProgram.programId,
    })
    .instruction()

/** `narrowTo: null` revokes the entry; a timestamp ends its window there (FR-032). */
export const revokeInstruction = (
  program: Program<DrainCover>,
  protocol: ProtocolView,
  seq: number,
  narrowTo: number | null,
): Promise<TransactionInstruction> =>
  program.methods
    .revokeDeclaration(new BN(seq), narrowTo === null ? null : new BN(narrowTo))
    .accountsPartial({
      protocol: protocol.address,
      authority: protocol.authority,
      entry: findDeclarationEntry(program.programId, protocol.address, seq),
    })
    .instruction()
