import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DRAIN_COVER_IDL } from '@mandate/sdk'
import { METHOD_BYTES, base58Decode, methodOf } from '@mandate/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  NATIVE_INSTRUCTIONS,
  OperationError,
  anchorDiscriminator,
  idlSchema,
  nativeNameOf,
  resolveOperation,
  snakeCase,
  toHex,
} from './operation'

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const SYSTEM = '11111111111111111111111111111111'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ANCHOR_PROGRAM = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'

describe('the native table', () => {
  it('names exactly the programs attestors read narrower than eight bytes', () => {
    expect(Object.keys(NATIVE_INSTRUCTIONS).sort()).toEqual(Object.keys(METHOD_BYTES).sort())
  })

  it('gives every instruction its own bytes, within the method width', () => {
    for (const [programId, table] of Object.entries(NATIVE_INSTRUCTIONS)) {
      const width = METHOD_BYTES[programId] ?? 8
      const opcodes = Object.values(table).map(({ opcode }) => opcode)
      expect(new Set(opcodes).size, programId).toBe(opcodes.length)
      for (const opcode of opcodes) expect(opcode, programId).toBeLessThan(256 ** width)
    }
  })
})

// Mainnet transactions signed by real upgrade authorities (SC-002). Every native method
// they used has to be nameable, or a protocol would be pushed to hand-written bytes for
// the very operations it performs most.
const FIXTURES = join(import.meta.dirname, '../../../packages/shared/src/__fixtures__/privileged')
const instructionSchema = z.object({
  programId: z.string(),
  data: z.string(),
  accounts: z.array(z.string()),
})
const fixtureSchema = z.object({
  transactions: z.array(
    z.object({
      instructions: z.array(instructionSchema),
      innerInstructions: z.array(z.object({ instructions: z.array(instructionSchema) })),
    }),
  ),
})
const realNative = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json') && name !== 'skipped.json')
  .flatMap((name) =>
    fixtureSchema
      .parse(JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')))
      .transactions.flatMap((tx) => [
        ...tx.instructions,
        ...tx.innerInstructions.flatMap((group) => group.instructions),
      ]),
  )
  .filter((ix) => NATIVE_INSTRUCTIONS[ix.programId] !== undefined)
  .map((ix) => {
    const data = base58Decode(ix.data)
    return { ...ix, bytes: data, name: nativeNameOf(ix.programId, methodOf(ix.programId, data)) }
  })

describe('the native table against real mainnet transactions', () => {
  it('has plenty to check', () => {
    expect(realNative.length).toBeGreaterThan(200)
    expect(realNative.some((ix) => ix.programId === LOADER)).toBe(true)
  })

  it('names every native method they used', () => {
    expect(realNative.filter((ix) => ix.name === undefined).map((ix) => ix.programId)).toEqual([])
  })

  it('agrees with what the instructions carry', () => {
    // Shapes fixed by each program's encoding. An opcode under the wrong name shows up as
    // an instruction of the wrong size — but only if the name is checked whichever way
    // round, so every shape below must also be seen at least once.
    const SHAPES: Record<string, (ix: (typeof realNative)[number]) => boolean> = {
      [`${SYSTEM}:transfer`]: (ix) => ix.bytes.length === 12,
      [`${SYSTEM}:create_account`]: (ix) => ix.bytes.length === 52,
      [`${LOADER}:upgrade`]: (ix) => ix.bytes.length === 4 && ix.accounts.length === 7,
      [`${LOADER}:write`]: (ix) => ix.bytes.length > 16 && ix.accounts.length === 2,
      [`${LOADER}:initialize_buffer`]: (ix) => ix.bytes.length === 4,
      [`${TOKEN}:transfer`]: (ix) => ix.bytes.length === 9,
      [`${TOKEN}:transfer_checked`]: (ix) => ix.bytes.length === 10,
    }
    const misnamed = realNative
      .map((ix) => ({ ix, key: `${ix.programId}:${ix.name}` }))
      .filter(({ ix, key }) => SHAPES[key] !== undefined && !SHAPES[key]?.(ix))
      .map(({ key, ix }) => `${key} with ${ix.bytes.length} bytes, ${ix.accounts.length} accounts`)
    expect(misnamed).toEqual([])

    const seen = new Set(realNative.map((ix) => `${ix.programId}:${ix.name}`))
    expect(Object.keys(SHAPES).filter((key) => !seen.has(key))).toEqual([])
  })
})

// Our own program's IDL, as `anchor build` wrote it: the new format, with discriminators.
const idl = idlSchema.parse(DRAIN_COVER_IDL)
const discriminatorOf = (name: string) =>
  idl.instructions.find((ix) => ix.name === name)?.discriminator

describe('resolveOperation', () => {
  it('answers a native program from the table, in its own width', () => {
    const upgrade = resolveOperation({ programId: LOADER, instruction: 'Upgrade' })
    expect(upgrade.discriminator).toEqual([3, 0, 0, 0, 0, 0, 0, 0])
    expect(upgrade.knownToMoveFunds).toBe(true)

    const transfer = resolveOperation({ programId: TOKEN, instruction: 'transferChecked' })
    expect(transfer.discriminator).toEqual([12, 0, 0, 0, 0, 0, 0, 0])
    expect(resolveOperation({ programId: LOADER, instruction: 'write' }).knownToMoveFunds).toBe(
      false,
    )
  })

  it('takes the discriminator from an Anchor IDL', () => {
    const op = resolveOperation({
      programId: ANCHOR_PROGRAM,
      instruction: 'submitDeclaration',
      idl,
    })
    expect(op.discriminator).toEqual(discriminatorOf('submit_declaration'))
    expect(op.knownToMoveFunds).toBeUndefined()
  })

  it('derives it the way Anchor does when an old IDL carries none', () => {
    expect(idl.instructions.length).toBeGreaterThan(10)
    for (const ix of idl.instructions) {
      expect(anchorDiscriminator(ix.name), ix.name).toEqual(ix.discriminator)
    }
    const old = { instructions: [{ name: 'revokeDeclaration' }] }
    const op = resolveOperation({
      programId: ANCHOR_PROGRAM,
      instruction: 'revoke_declaration',
      idl: old,
    })
    expect(op.discriminator).toEqual(discriminatorOf('revoke_declaration'))
  })

  it('accepts hex, and names it when the table knows it', () => {
    const op = resolveOperation({ programId: LOADER, discriminator: '0x03000000' })
    expect(op.discriminator).toEqual([3, 0, 0, 0, 0, 0, 0, 0])
    expect(op.label).toBe('upgrade (0x0300000000000000)')
    expect(op.knownToMoveFunds).toBe(true)
  })

  it('refuses bytes attestors would zero before comparing', () => {
    // A System transfer's first eight bytes include half the amount.
    expect(() =>
      resolveOperation({ programId: SYSTEM, discriminator: '0200000040420f00' }),
    ).toThrow(/would never match — use 0200000000000000/)
  })

  it('refuses what it cannot resolve, and says what it could', () => {
    expect(() => resolveOperation({ programId: LOADER })).toThrow(OperationError)
    expect(() =>
      resolveOperation({ programId: LOADER, instruction: 'upgrade', discriminator: '03' }),
    ).toThrow(/exactly one/)
    expect(() => resolveOperation({ programId: LOADER, instruction: 'deploy' })).toThrow(
      /known: .*upgrade/,
    )
    expect(() => resolveOperation({ programId: ANCHOR_PROGRAM, instruction: 'pause' })).toThrow(
      /--idl/,
    )
    expect(() =>
      resolveOperation({
        programId: ANCHOR_PROGRAM,
        instruction: 'pause',
        idl: { instructions: [] },
      }),
    ).toThrow(/has no instruction pause/)
    expect(() => resolveOperation({ programId: ANCHOR_PROGRAM, discriminator: 'xyz' })).toThrow(
      /hex/,
    )
  })
})

describe('names', () => {
  it('folds case and separators to Anchor’s snake_case', () => {
    expect(snakeCase('SetAuthority')).toBe('set_authority')
    expect(snakeCase('setAuthorityChecked')).toBe('set_authority_checked')
    expect(snakeCase('initialize-account3')).toBe('initialize_account3')
    expect(toHex([0, 255, 16])).toBe('00ff10')
  })
})
