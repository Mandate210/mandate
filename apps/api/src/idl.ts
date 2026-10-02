// Instruction names from a declared program's own on-chain Anchor IDL (T050).
//
// Decided 2026-10-02: the one human-readable field of the contract —
// `instruction.name` of a declaration entry — comes from the IDL the declared program
// publishes on chain, and from nothing else: a name we typed in would be our claim
// about somebody else's program. The indexer reads it again on every census, so the
// cache stays a function of the chain as it is now, and a dropped cache rebuilds to the
// same names. Pure: bytes in, names out.
//
// Only the legacy IDL account (`anchor idl init`, every Anchor release up to 0.32) is
// read. The Program Metadata program is the other place an IDL can live; it waits for a
// real program to check its seeds against.

import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

export const IDL_SEED = 'anchor:idl'

/** `createWithSeed(findProgramAddress([], program), "anchor:idl", program)`, as Anchor derives it. */
export const idlAddress = async (program: string): Promise<string> => {
  const id = new PublicKey(program)
  const [base] = PublicKey.findProgramAddressSync([], id)
  return (await PublicKey.createWithSeed(base, IDL_SEED, id)).toBase58()
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest()

/**
 * `IdlAccount`'s discriminator, then `authority` (32) and `data_len` (u32) before the data.
 * Anchor declares it `#[account("internal")]`, so the namespace is `internal`, not
 * `account` — checked against the real accounts in `__fixtures__/idl/`.
 */
const IDL_ACCOUNT_DISCRIMINATOR = sha256('internal:IdlAccount').subarray(0, 8)
const DATA_LEN_OFFSET = 8 + 32
const DATA_OFFSET = DATA_LEN_OFFSET + 4

/** Declarations carry eight bytes; a name is only given to an instruction that has as many. */
const DISCRIMINATOR_BYTES = 8

/**
 * What is read from the IDL — nothing more, so a program's IDL that differs elsewhere
 * from what we expect still names its instructions.
 */
const idlSchema = z.object({
  instructions: z.array(
    z.object({
      name: z.string().min(1),
      /** Present from Anchor 0.30 on, and authoritative: it may be a custom one. */
      discriminator: z.array(z.number().int().min(0).max(255)).optional(),
    }),
  ),
})

/**
 * The Rust name behind a legacy IDL's camelCase one: before 0.30 the IDL lowered the
 * case of `deposit_margin_account` to `depositMarginAccount`, while the discriminator
 * was always hashed from the Rust name. A name with a digit after an underscore
 * (`swap_2` → `swap2`) cannot be recovered and gets no name — never a wrong one.
 */
const rustName = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

const toHex = (bytes: Iterable<number>): string => Buffer.from([...bytes]).toString('hex')

/**
 * Discriminator (sixteen hex digits) → instruction name, from the raw IDL account; `null`
 * when the bytes are not an IDL Anchor wrote. Two instructions with one discriminator
 * name neither: which of them a declaration means is not ours to choose.
 */
export const instructionNamesFromIdl = (data: Buffer): Map<string, string> | null => {
  if (data.length < DATA_OFFSET) return null
  if (!data.subarray(0, 8).equals(IDL_ACCOUNT_DISCRIMINATOR)) return null
  const length = data.readUInt32LE(DATA_LEN_OFFSET)
  if (DATA_OFFSET + length > data.length) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(
      inflateSync(data.subarray(DATA_OFFSET, DATA_OFFSET + length)).toString('utf8'),
    )
  } catch {
    return null
  }
  const idl = idlSchema.safeParse(parsed)
  if (!idl.success) return null

  const names = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const instruction of idl.data.instructions) {
    const bytes =
      instruction.discriminator ?? sha256(`global:${rustName(instruction.name)}`).subarray(0, 8)
    if (bytes.length !== DISCRIMINATOR_BYTES) continue
    const key = toHex(bytes)
    if (names.has(key)) ambiguous.add(key)
    names.set(key, instruction.name)
  }
  for (const key of ambiguous) names.delete(key)
  return names
}
