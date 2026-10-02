import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { idlAddress, instructionNamesFromIdl } from './idl'

/** A real IDL account from mainnet, and instructions of real transactions of its program. */
type IdlFixture = {
  programId: string
  idlAddress: string
  owner: string
  dataBase64: string
  instructions: { signature: string; discriminator: string }[]
}

const fixture = (program: string): IdlFixture =>
  JSON.parse(
    readFileSync(new URL(`./__fixtures__/idl/${program}.json`, import.meta.url), 'utf8'),
  ) as IdlFixture

/** Anchor ≥ 0.30: every instruction carries its discriminator. */
const JUPITER = fixture('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
/** Before 0.30: camelCase names, discriminators to be hashed from the Rust name. */
const TENSORSWAP = fixture('TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN')

const accountData = (f: IdlFixture) => Buffer.from(f.dataBase64, 'base64')

/** An IDL account as Anchor writes it, around any JSON. */
const idlAccount = (idl: unknown): Buffer => {
  const real = accountData(JUPITER)
  const compressed = deflateSync(Buffer.from(JSON.stringify(idl)))
  const length = Buffer.alloc(4)
  length.writeUInt32LE(compressed.length)
  return Buffer.concat([real.subarray(0, 40), length, compressed])
}

describe('idlAddress', () => {
  it('derives the address the IDL was actually read from', async () => {
    for (const f of [JUPITER, TENSORSWAP]) {
      expect(await idlAddress(f.programId)).toBe(f.idlAddress)
    }
  })
})

describe('instructionNamesFromIdl', () => {
  it("names every instruction real transactions ran, from a 0.30+ IDL's own discriminators", () => {
    const names = instructionNamesFromIdl(accountData(JUPITER))
    expect(names).not.toBeNull()
    for (const { discriminator } of JUPITER.instructions) {
      expect(names?.get(discriminator), discriminator).toEqual(expect.any(String))
    }
  })

  it('recovers legacy discriminators from camelCase names, checked on real transactions', () => {
    const names = instructionNamesFromIdl(accountData(TENSORSWAP))
    expect(
      Object.fromEntries(
        TENSORSWAP.instructions.map(({ discriminator }) => [
          discriminator,
          names?.get(discriminator),
        ]),
      ),
    ).toEqual({
      be55f23c775121c0: 'depositMarginAccount',
      '364996d0cf051211': 'withdrawMarginAccount',
    })
  })

  it('reads a single-word legacy name the same way', () => {
    // sha256("global:initialize")[..8], the best-known Anchor discriminator.
    const names = instructionNamesFromIdl(idlAccount({ instructions: [{ name: 'initialize' }] }))
    expect(names?.get('afaf6d1f0d989bed')).toBe('initialize')
  })

  it('names neither of two instructions sharing a discriminator', () => {
    const names = instructionNamesFromIdl(
      idlAccount({
        instructions: [
          { name: 'pause', discriminator: [1, 2, 3, 4, 5, 6, 7, 8] },
          { name: 'withdraw', discriminator: [1, 2, 3, 4, 5, 6, 7, 8] },
          { name: 'resume', discriminator: [9, 9, 9, 9, 9, 9, 9, 9] },
        ],
      }),
    )
    expect(names).toEqual(new Map([['0909090909090909', 'resume']]))
  })

  it('skips a custom discriminator that is not eight bytes', () => {
    const names = instructionNamesFromIdl(
      idlAccount({ instructions: [{ name: 'short', discriminator: [7] }] }),
    )
    expect(names).toEqual(new Map())
  })

  it('refuses what Anchor did not write', () => {
    const real = accountData(JUPITER)
    const wrongKind = Buffer.from(real)
    wrongKind[0] = (wrongKind[0] ?? 0) ^ 0xff
    const truncated = real.subarray(0, 100)
    const notJson = Buffer.concat([
      real.subarray(0, 40),
      Buffer.from([3, 0, 0, 0]),
      Buffer.from('abc'),
    ])

    expect(instructionNamesFromIdl(wrongKind)).toBeNull()
    expect(instructionNamesFromIdl(truncated)).toBeNull()
    expect(instructionNamesFromIdl(notJson)).toBeNull()
    expect(instructionNamesFromIdl(idlAccount({ name: 'no instructions' }))).toBeNull()
    expect(instructionNamesFromIdl(Buffer.alloc(10))).toBeNull()
  })
})
