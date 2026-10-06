import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Program } from '@coral-xyz/anchor'
import { type Io, run } from '@mandate/cli/declare'
import { type DrainCover, createProgram, findDeclarationEntry } from '@mandate/sdk'
import { Keypair, Transaction } from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type TestEnv,
  clusterTimestamp,
  setupTestEnv,
  testRpcUrl,
  validatorReachable,
} from './harness'
import { type RegisteredProtocol, ensureConfig, registerProtocol } from './world'

// T068 end to end: the CLI against the program, both ways of signing. The unit tests
// cover what it refuses before an RPC; this covers that what it sends is what the
// program accepts, and that what it prints for a multisig is a transaction that lands.

const reachable = await validatorReachable()

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const DAY = 86_400

const listSchema = z.object({
  entries: z.array(z.object({ seq: z.number(), state: z.string(), ixDiscriminator: z.string() })),
})

describe.skipIf(!reachable)('mandate-declare against the program', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let target: RegisteredProtocol
  let dir: string
  let keyFile: string

  const cli = async (argv: string[], confirm?: Io['confirm']) => {
    const out: string[] = []
    const err: string[] = []
    const code = await run([...argv, '--rpc', testRpcUrl()], {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      confirm,
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const protocolArg = () => ['--protocol', target.protocol.toBase58()]
  const entryAt = (seq: number) =>
    program.account.declarationEntry.fetch(
      findDeclarationEntry(program.programId, target.protocol, seq),
    )
  const nextSeq = async () =>
    (await program.account.protocol.fetch(target.protocol)).nextDeclarationSeq.toNumber()

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
    target = await registerProtocol(program, env)
    dir = mkdtempSync(join(tmpdir(), 'mandate-declare-'))
    keyFile = join(dir, 'authority.json')
    writeFileSync(keyFile, JSON.stringify([...target.authority.secretKey]))
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('submits a bounded upgrade window, signed with the key file', async () => {
    const now = await clusterTimestamp(env.connection)
    const seq = await nextSeq()
    const result = await cli([
      'submit',
      ...protocolArg(),
      '--program',
      LOADER,
      '--instruction',
      'upgrade',
      '--from',
      String(now),
      '--until',
      String(now + 3 * DAY),
      '--moves-funds',
      '--keypair',
      keyFile,
      '--yes',
    ])

    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/^sent /m)
    const stored = await entryAt(seq)
    expect(stored.programId.toBase58()).toBe(LOADER)
    expect(stored.ixDiscriminator).toEqual([3, 0, 0, 0, 0, 0, 0, 0])
    expect(stored.notAfter?.toNumber()).toBe(now + 3 * DAY)
    expect(stored.movesFunds).toBe(true)
  })

  it('refuses a permanent upgrade window before signing anything', async () => {
    const before = await nextSeq()
    const result = await cli([
      'submit',
      ...protocolArg(),
      '--program',
      LOADER,
      '--instruction',
      'upgrade',
      '--from',
      'now',
      '--permanent',
      '--no-moves-funds',
      '--keypair',
      keyFile,
      '--yes',
    ])
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/--moves-funds/)
    expect(await nextSeq()).toBe(before)
  })

  it('sends nothing when nobody confirms, and nothing on a no', async () => {
    const before = await nextSeq()
    const args = [
      'submit',
      ...protocolArg(),
      '--program',
      LOADER,
      '--instruction',
      'write',
      '--from',
      'now',
      '--permanent',
      '--no-moves-funds',
      '--keypair',
      keyFile,
    ]
    expect((await cli(args)).code).toBe(1)
    expect((await cli(args, async () => false)).code).toBe(1)
    expect(await nextSeq()).toBe(before)
  })

  it('refuses a key that is not the protocol authority, naming both', async () => {
    const stranger = join(dir, 'stranger.json')
    const other = Keypair.generate()
    writeFileSync(stranger, JSON.stringify([...other.secretKey]))
    const result = await cli([
      'revoke',
      ...protocolArg(),
      '--seq',
      '0',
      '--keypair',
      stranger,
      '--yes',
    ])
    expect(result.code).toBe(2)
    expect(result.err).toContain(other.publicKey.toBase58())
    expect(result.err).toContain(target.authority.publicKey.toBase58())
  })

  it('resolves an Anchor instruction from the IDL the program published', async () => {
    const now = await clusterTimestamp(env.connection)
    const seq = await nextSeq()
    const result = await cli([
      'submit',
      ...protocolArg(),
      '--program',
      program.programId.toBase58(),
      '--instruction',
      'setAttestor',
      '--from',
      'now',
      '--until',
      String(now + 2 * DAY),
      '--moves-funds',
      '--keypair',
      keyFile,
      '--yes',
    ])
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    const fromIdl = (
      await program.account.declarationEntry.fetch(
        findDeclarationEntry(program.programId, target.protocol, seq),
      )
    ).ixDiscriminator
    expect(fromIdl).toEqual(
      program.idl.instructions.find((ix) => ix.name === 'setAttestor')?.discriminator,
    )
  })

  it('narrows, then revokes, each at once (FR-032)', async () => {
    const now = await clusterTimestamp(env.connection)
    const narrowTo = now + 2 * DAY
    expect(
      (
        await cli([
          'narrow',
          ...protocolArg(),
          '--seq',
          '0',
          '--until',
          String(narrowTo),
          '--keypair',
          keyFile,
          '--yes',
        ])
      ).code,
    ).toBe(0)
    expect((await entryAt(0)).notAfter?.toNumber()).toBe(narrowTo)

    expect(
      (await cli(['revoke', ...protocolArg(), '--seq', '0', '--keypair', keyFile, '--yes'])).code,
    ).toBe(0)
    expect((await entryAt(0)).revokedAt).not.toBeNull()

    const again = await cli([
      'revoke',
      ...protocolArg(),
      '--seq',
      '0',
      '--keypair',
      keyFile,
      '--yes',
    ])
    expect(again.code).toBe(1)
    expect(again.err).toMatch(/already revoked/)
  })

  it('lists what stands, pending included, and the rest on --all', async () => {
    const live = listSchema.parse(JSON.parse((await cli(['list', ...protocolArg(), '--json'])).out))
    const all = listSchema.parse(
      JSON.parse((await cli(['list', ...protocolArg(), '--json', '--all'])).out),
    )

    expect(live.entries.map((e) => e.seq)).not.toContain(0)
    expect(live.entries.every((e) => e.state === 'pending')).toBe(true)
    expect(all.entries.find((e) => e.seq === 0)?.state).toBe('revoked')
    expect(all.entries.length).toBe(live.entries.length + 1)

    const text = await cli(['list', ...protocolArg()])
    expect(text.code).toBe(0)
    expect(text.out).toMatch(/1 revoked or expired not shown/)
  })

  it('prints for a multisig a transaction that lands once the authority signs it', async () => {
    const now = await clusterTimestamp(env.connection)
    const seq = await nextSeq()
    const result = await cli([
      'submit',
      ...protocolArg(),
      '--program',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      '--discriminator',
      '06',
      '--from',
      'now',
      '--until',
      String(now + 5 * DAY),
      '--moves-funds',
      '--unsigned',
    ])
    expect(result.code).toBe(0)
    expect(await nextSeq()).toBe(seq)

    const base64 = /^ {2}base64 {2}(\S+)$/m.exec(result.out)?.[1]
    expect(base64).toBeDefined()
    const tx = Transaction.from(Buffer.from(base64 ?? '', 'base64'))
    expect(tx.feePayer?.equals(target.authority.publicKey)).toBe(true)
    // The signer does its own part, as a multisig would: a fresh blockhash, its key.
    tx.recentBlockhash = (await env.connection.getLatestBlockhash()).blockhash
    tx.sign(target.authority)
    await env.connection.confirmTransaction(
      await env.connection.sendRawTransaction(tx.serialize()),
      'confirmed',
    )

    const stored = await entryAt(seq)
    expect(stored.ixDiscriminator).toEqual([6, 0, 0, 0, 0, 0, 0, 0])
    expect(result.out).toContain('set_authority (0x0600000000000000)')
  })
})
