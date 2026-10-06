// Which operation an entry declares: a program id and the eight bytes attestors compare
// (T068).
//
// The bytes are the whole contract. An entry whose discriminator is off by one byte
// covers nothing, and the protocol finds out when its own maintenance opens an incident
// against it — so nothing here asks the operator to write bytes by hand unless they
// insist, and whatever comes out is normalised by the same `methodOf` every attestor
// runs.

import { createHash } from 'node:crypto'
import { DISCRIMINATOR_BYTES, METHOD_BYTES, methodOf } from '@mandate/shared'
import { z } from 'zod'

export interface NativeInstruction {
  readonly opcode: number
  /**
   * Known to move funds or hand over control of them, so a permanent window is refused
   * before anything is signed (FR-035). `false` means «not known to», never «known not
   * to»: the protocol still says so itself (`docs/PLAN.md` → R-9).
   */
  readonly movesFunds: boolean
}

type Table = Readonly<Record<string, NativeInstruction>>

const moves = (opcode: number): NativeInstruction => ({ opcode, movesFunds: true })
const inert = (opcode: number): NativeInstruction => ({ opcode, movesFunds: false })

/** SPL Token's base set; Token-2022 shares it byte for byte. Extensions are not here. */
const TOKEN: Table = {
  initialize_mint: inert(0),
  initialize_account: inert(1),
  initialize_multisig: inert(2),
  transfer: moves(3),
  approve: moves(4),
  revoke: inert(5),
  set_authority: moves(6),
  mint_to: moves(7),
  burn: moves(8),
  close_account: moves(9),
  freeze_account: inert(10),
  thaw_account: inert(11),
  transfer_checked: moves(12),
  approve_checked: moves(13),
  mint_to_checked: moves(14),
  burn_checked: moves(15),
  initialize_account2: inert(16),
  sync_native: inert(17),
  initialize_account3: inert(18),
  initialize_multisig2: inert(19),
  initialize_mint2: inert(20),
  get_account_data_size: inert(21),
  initialize_immutable_owner: inert(22),
  amount_to_ui_amount: inert(23),
  ui_amount_to_amount: inert(24),
}

/**
 * Instruction names for exactly the programs `METHOD_BYTES` knows, in each program's
 * own encoding. `operation.test.ts` holds the two tables to the same set of programs:
 * a program here and not there would be compared on eight bytes, and its operands
 * would make every entry for it miss.
 */
export const NATIVE_INSTRUCTIONS: Readonly<Record<string, Table>> = {
  '11111111111111111111111111111111': {
    create_account: moves(0),
    assign: moves(1),
    transfer: moves(2),
    create_account_with_seed: moves(3),
    advance_nonce_account: inert(4),
    withdraw_nonce_account: moves(5),
    initialize_nonce_account: inert(6),
    authorize_nonce_account: moves(7),
    allocate: inert(8),
    allocate_with_seed: inert(9),
    assign_with_seed: moves(10),
    transfer_with_seed: moves(11),
    upgrade_nonce_account: inert(12),
  },
  BPFLoaderUpgradeab1e11111111111111111111111: {
    initialize_buffer: inert(0),
    write: inert(1),
    deploy_with_max_data_len: moves(2),
    // New code is new control over everything the program holds.
    upgrade: moves(3),
    set_authority: moves(4),
    close: moves(5),
    extend_program: moves(6),
    set_authority_checked: moves(7),
    migrate: moves(8),
    extend_program_checked: moves(9),
  },
  AddressLookupTab1e1111111111111111111111111: {
    create_lookup_table: inert(0),
    freeze_lookup_table: inert(1),
    extend_lookup_table: inert(2),
    deactivate_lookup_table: inert(3),
    close_lookup_table: moves(4),
  },
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: TOKEN,
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: TOKEN,
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: {
    create: inert(0),
    create_idempotent: inert(1),
    recover_nested: moves(2),
  },
}

/** `SetAuthority`, `setAuthority` and `set-authority` are one instruction. */
export const snakeCase = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()

/** Anchor's rule: the first eight bytes of `sha256("global:<snake_case name>")`. */
export const anchorDiscriminator = (name: string): number[] => [
  ...createHash('sha256')
    .update(`global:${snakeCase(name)}`)
    .digest()
    .subarray(0, DISCRIMINATOR_BYTES),
]

/**
 * The part of an Anchor IDL this needs, old format or new. From 0.30 an instruction
 * carries its discriminator; before that it is derived from the name.
 */
export const idlSchema = z.object({
  instructions: z.array(
    z.object({
      name: z.string().min(1),
      discriminator: z.array(z.number().int().min(0).max(255)).length(8).optional(),
    }),
  ),
})
export type Idl = z.infer<typeof idlSchema>

export interface Operation {
  readonly programId: string
  /** Exactly what goes on-chain, already in the shape attestors compare. */
  readonly discriminator: number[]
  /** How it was named, for the confirmation screen. */
  readonly label: string
  /** From the native table; `undefined` when nothing is known either way. */
  readonly knownToMoveFunds: boolean | undefined
}

export class OperationError extends Error {
  override name = 'OperationError'
}

export const toHex = (bytes: readonly number[]): string =>
  bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')

const fromHex = (text: string): number[] => {
  const hex = text.replace(/^0x/i, '')
  if (!/^([0-9a-f]{2})+$/i.test(hex) || hex.length > DISCRIMINATOR_BYTES * 2) {
    throw new OperationError(`--discriminator wants up to 16 hex digits, got ${text}`)
  }
  const bytes = Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  )
  return [...bytes, ...Array<number>(DISCRIMINATOR_BYTES - bytes.length).fill(0)]
}

const opcodeBytes = (programId: string, opcode: number): number[] => {
  const width = METHOD_BYTES[programId] ?? DISCRIMINATOR_BYTES
  const bytes = Array.from({ length: width }, (_, i) => (opcode >>> (8 * i)) & 0xff)
  return methodOf(programId, bytes)
}

/** The built-in name of a native operation, from the bytes an entry stores. */
export const nativeNameOf = (
  programId: string,
  discriminator: readonly number[],
): string | undefined => {
  const native = NATIVE_INSTRUCTIONS[programId]
  if (native === undefined) return undefined
  const wanted = toHex(discriminator)
  return Object.entries(native).find(
    ([, { opcode }]) => toHex(opcodeBytes(programId, opcode)) === wanted,
  )?.[0]
}

/**
 * Resolves `--instruction` or `--discriminator` for one program.
 *
 * Native programs answer from the table and never from an IDL — they have none, and
 * their opcodes are narrower than eight bytes. Anything else is Anchor: the IDL's own
 * discriminator when it has one, Anchor's derivation when it does not.
 */
export const resolveOperation = ({
  programId,
  instruction,
  discriminator,
  idl,
}: {
  programId: string
  instruction?: string | undefined
  discriminator?: string | undefined
  idl?: Idl | undefined
}): Operation => {
  if ((instruction === undefined) === (discriminator === undefined)) {
    throw new OperationError('give exactly one of --instruction and --discriminator')
  }
  const native = NATIVE_INSTRUCTIONS[programId]

  if (discriminator !== undefined) {
    const bytes = fromHex(discriminator)
    const normalised = methodOf(programId, bytes)
    // Bytes past the method's width are operands, and attestors zero them before they
    // compare: an entry that kept them would match nothing, ever.
    if (toHex(normalised) !== toHex(bytes)) {
      throw new OperationError(
        `${programId} identifies a method by its first ${METHOD_BYTES[programId]} byte(s); ` +
          `${toHex(bytes)} would never match — use ${toHex(normalised)}`,
      )
    }
    const named = nativeNameOf(programId, normalised)
    return {
      programId,
      discriminator: normalised,
      label: named === undefined ? `0x${toHex(normalised)}` : `${named} (0x${toHex(normalised)})`,
      knownToMoveFunds: named === undefined ? undefined : native?.[named]?.movesFunds,
    }
  }

  const wanted = snakeCase(instruction ?? '')
  if (native !== undefined) {
    const found = native[wanted]
    if (found === undefined) {
      throw new OperationError(
        `${programId} has no instruction ${instruction} in the built-in table; ` +
          `known: ${Object.keys(native).join(', ')} — or pass --discriminator`,
      )
    }
    const bytes = opcodeBytes(programId, found.opcode)
    return {
      programId,
      discriminator: bytes,
      label: `${wanted} (0x${toHex(bytes)})`,
      knownToMoveFunds: found.movesFunds,
    }
  }

  if (idl === undefined) {
    throw new OperationError(
      `no IDL for ${programId}: it has none on-chain — pass --idl <file> or --discriminator`,
    )
  }
  const found = idl.instructions.find((ix) => snakeCase(ix.name) === wanted)
  if (found === undefined) {
    throw new OperationError(
      `the IDL of ${programId} has no instruction ${instruction}; ` +
        `it has: ${idl.instructions.map((ix) => snakeCase(ix.name)).join(', ')}`,
    )
  }
  const bytes = found.discriminator ?? anchorDiscriminator(found.name)
  return {
    programId,
    discriminator: bytes,
    label: `${wanted} (0x${toHex(bytes)})`,
    knownToMoveFunds: undefined,
  }
}
