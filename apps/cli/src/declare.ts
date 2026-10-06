// The covered protocol's side of FR-034: declare, narrow and revoke maintenance windows,
// and see what stands (T068).
//
// `web` writes nothing, so without this the only way to declare a window is a raw
// transaction through the SDK. Every action here is still a transaction the protocol's
// own authority signs: either the CLI signs it locally with a key file it reads and
// forgets, or it prints the transaction unsigned for a multisig to propose — 5 of the 17
// privileged addresses behind SC-002 are multisig PDAs, which have no key to give.
// Nothing is stored and nothing is sent anywhere but the RPC named on the command line.

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { utils } from '@coral-xyz/anchor'
import { entryStateAt } from '@mandate/shared'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { z } from 'zod'
import {
  type NumberedEntry,
  type ProtocolView,
  clusterNow,
  fetchIdl,
  programFor,
  readDelay,
  readEntries,
  readEntry,
  readProtocol,
  revokeInstruction,
  submitInstruction,
} from './chain'
import {
  type Idl,
  NATIVE_INSTRUCTIONS,
  idlSchema,
  nativeNameOf,
  resolveOperation,
  toHex,
} from './operation'
import { checkNarrow, checkRevoke, checkSubmit, isLive, isoOf, parseTime } from './window'

export const USAGE = `mandate-declare — a covered protocol's declaration entries (FR-006, FR-031, FR-032, FR-035)

  submit  --protocol <addr> --program <id> (--instruction <name> [--idl <file>] | --discriminator <hex>)
          --from <time> (--until <time> | --permanent) (--moves-funds | --no-moves-funds)
  narrow  --protocol <addr> --seq <n> --until <time>
  revoke  --protocol <addr> --seq <n>
  list    --protocol <addr> [--all] [--json]

Signing (submit, narrow, revoke) — exactly one:
  --keypair <file>   the protocol authority's key, a Solana CLI JSON file; read, used, never kept
  --unsigned         print the transaction unsigned, for a multisig or another signer

  --rpc <url>        defaults to SOLANA_RPC_URL
  --yes              send without asking

<time> is unix seconds, "now", or ISO 8601 with a zone: 2026-10-07T12:00:00Z`

export interface Io {
  out: (line: string) => void
  err: (line: string) => void
  /** Whether to send. Absent when nobody can answer — then only --yes sends. */
  confirm?: ((question: string) => Promise<boolean>) | undefined
}

class UsageError extends Error {
  override name = 'UsageError'
}

const OPTIONS = {
  protocol: { type: 'string' },
  program: { type: 'string' },
  instruction: { type: 'string' },
  idl: { type: 'string' },
  discriminator: { type: 'string' },
  from: { type: 'string' },
  until: { type: 'string' },
  permanent: { type: 'boolean' },
  'moves-funds': { type: 'boolean' },
  'no-moves-funds': { type: 'boolean' },
  seq: { type: 'string' },
  keypair: { type: 'string' },
  unsigned: { type: 'boolean' },
  rpc: { type: 'string' },
  yes: { type: 'boolean' },
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>['values']

const need = (values: Values, name: 'protocol' | 'program' | 'from' | 'until' | 'seq'): string => {
  const value = values[name]
  if (value === undefined) throw new UsageError(`--${name} is required`)
  return value
}

const address = (text: string, what: string): PublicKey => {
  try {
    return new PublicKey(text)
  } catch {
    throw new UsageError(`${what} is not an address: ${text}`)
  }
}

const seqOf = (values: Values): number => {
  const text = need(values, 'seq')
  if (!/^\d+$/.test(text)) throw new UsageError(`--seq is a whole number, got ${text}`)
  return Number(text)
}

const keypairFile = z.array(z.number().int().min(0).max(255)).length(64)

/** Read for one transaction and dropped; the path is the only thing ever printed. */
const loadKeypair = (path: string): Keypair => {
  const parsed = keypairFile.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) {
    throw new UsageError(`${path} is not a Solana CLI keypair file (a JSON array of 64 bytes)`)
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed.data))
}

type Signing = { kind: 'keypair'; keypair: Keypair } | { kind: 'unsigned' }

const signingOf = (values: Values, protocol: ProtocolView): Signing => {
  if ((values.keypair === undefined) === (values.unsigned !== true)) {
    throw new UsageError('give exactly one of --keypair <file> and --unsigned')
  }
  if (values.keypair === undefined) return { kind: 'unsigned' }
  const keypair = loadKeypair(values.keypair)
  // Checked here rather than left to `has_one`: the refusal names both keys, and
  // nobody pays a fee to learn they picked the wrong file.
  if (!keypair.publicKey.equals(protocol.authority)) {
    throw new UsageError(
      `${values.keypair} holds ${keypair.publicKey.toBase58()}, but the protocol's authority is ${protocol.authority.toBase58()}`,
    )
  }
  return { kind: 'keypair', keypair }
}

const describe = ({ seq, entry }: NumberedEntry, now: number): string[] => {
  const name = nativeNameOf(entry.programId, entry.ixDiscriminator)
  return [
    `#${seq}  ${entryStateAt(entry, now)}`,
    `  operation   ${entry.programId} 0x${toHex(entry.ixDiscriminator)}${name === undefined ? '' : ` (${name})`}`,
    `  window      ${isoOf(entry.notBefore)} → ${entry.notAfter === null ? 'permanent' : isoOf(entry.notAfter)}`,
    `  moves funds ${entry.movesFunds ? 'yes' : 'no'}`,
    `  effective   ${isoOf(entry.effectiveAt)} (submitted ${isoOf(entry.submittedAt)})`,
    ...(entry.revokedAt === null ? [] : [`  revoked     ${isoOf(entry.revokedAt)}`]),
  ]
}

/** Sends with the key, or prints what a multisig needs to propose it. */
const deliver = async (
  connection: Connection,
  instruction: TransactionInstruction,
  signing: Signing,
  protocol: ProtocolView,
  io: Io,
  yes: boolean,
): Promise<number> => {
  if (signing.kind === 'unsigned') {
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: protocol.authority, recentBlockhash: blockhash }).add(
      instruction,
    )
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    io.out('')
    io.out(`unsigned transaction — fee payer and signer ${protocol.authority.toBase58()}`)
    io.out(`  base58  ${utils.bytes.bs58.encode(bytes)}`)
    io.out(`  base64  ${bytes.toString('base64')}`)
    io.out('instruction, for a multisig that proposes instructions rather than transactions:')
    io.out(
      JSON.stringify(
        {
          programId: instruction.programId.toBase58(),
          keys: instruction.keys.map((key) => ({
            pubkey: key.pubkey.toBase58(),
            isSigner: key.isSigner,
            isWritable: key.isWritable,
          })),
          data: instruction.data.toString('base64'),
        },
        null,
        2,
      ),
    )
    io.out('The blockhash expires in about a minute; a multisig re-wraps the instruction anyway.')
    return 0
  }

  if (!yes) {
    if (io.confirm === undefined) {
      io.err('not sent: nobody to confirm — pass --yes to send without asking')
      return 1
    }
    if (!(await io.confirm('Sign and send? [y/N] '))) {
      io.err('not sent')
      return 1
    }
  }
  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(instruction),
    [signing.keypair],
    { commitment: 'confirmed' },
  )
  io.out(`sent ${signature}`)
  return 0
}

const readIdl = async (
  connection: Connection,
  programId: PublicKey,
  path: string | undefined,
): Promise<Idl | undefined> => {
  if (path !== undefined) return idlSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  return (await fetchIdl(connection, programId)) ?? undefined
}

const submit = async (values: Values, connection: Connection, io: Io): Promise<number> => {
  const program = programFor(connection)
  const protocol = await readProtocol(program, address(need(values, 'protocol'), '--protocol'))
  const signing = signingOf(values, protocol)

  const movesFlag = values['moves-funds'] === true
  const inertFlag = values['no-moves-funds'] === true
  if (movesFlag === inertFlag) {
    throw new UsageError(
      'say whether the operation moves funds: --moves-funds or --no-moves-funds (FR-035)',
    )
  }
  if ((values.until === undefined) === (values.permanent !== true)) {
    throw new UsageError('give exactly one of --until <time> and --permanent')
  }

  const programId = address(need(values, 'program'), '--program')
  const native = NATIVE_INSTRUCTIONS[programId.toBase58()] !== undefined
  const idl =
    values.instruction === undefined || native
      ? undefined
      : await readIdl(connection, programId, values.idl)
  const operation = resolveOperation({
    programId: programId.toBase58(),
    instruction: values.instruction,
    discriminator: values.discriminator,
    idl,
  })

  const [now, delay] = await Promise.all([clusterNow(connection), readDelay(program)])
  const notBefore = parseTime(need(values, 'from'), now)
  const notAfter = values.until === undefined ? null : parseTime(values.until, now)
  const notes = checkSubmit(
    { notBefore, notAfter, movesFunds: movesFlag, knownToMoveFunds: operation.knownToMoveFunds },
    { now, delay },
  )

  io.out(`protocol    ${protocol.address.toBase58()} — new entry #${protocol.nextSeq}`)
  io.out(`operation   ${operation.programId} ${operation.label}`)
  io.out(`window      ${isoOf(notBefore)} → ${notAfter === null ? 'permanent' : isoOf(notAfter)}`)
  io.out(`moves funds ${movesFlag ? 'yes' : 'no'}`)
  io.out(`effective   ${isoOf(now + delay)} if it lands now (cluster time + ${delay} s, FR-031)`)
  for (const note of notes) io.out(`note: ${note}`)
  if (signing.kind === 'unsigned') {
    io.out(
      'note: the delay counts from execution, not from now — a proposal executed later takes ' +
        'effect later, and one executed after another entry lands is refused (the entry ' +
        'number is fixed in it)',
    )
  }

  return deliver(
    connection,
    await submitInstruction(program, protocol, {
      programId: operation.programId,
      discriminator: operation.discriminator,
      notBefore,
      notAfter,
      movesFunds: movesFlag,
    }),
    signing,
    protocol,
    io,
    values.yes === true,
  )
}

const revise = async (
  values: Values,
  connection: Connection,
  io: Io,
  narrow: boolean,
): Promise<number> => {
  const program = programFor(connection)
  const protocol = await readProtocol(program, address(need(values, 'protocol'), '--protocol'))
  const signing = signingOf(values, protocol)
  const numbered = await readEntry(program, protocol, seqOf(values))
  const now = await clusterNow(connection)

  let narrowTo: number | null = null
  if (narrow) {
    narrowTo = parseTime(need(values, 'until'), now)
    checkNarrow(numbered.entry, narrowTo, now)
  } else {
    checkRevoke(numbered.entry)
  }

  for (const line of describe(numbered, now)) io.out(line)
  io.out(
    narrowTo === null
      ? 'revoke: in force until now, never again — effective at once (FR-032)'
      : `narrow: the window will end at ${isoOf(narrowTo)}, effective at once (FR-032)`,
  )

  return deliver(
    connection,
    await revokeInstruction(program, protocol, numbered.seq, narrowTo),
    signing,
    protocol,
    io,
    values.yes === true,
  )
}

const list = async (values: Values, connection: Connection, io: Io): Promise<number> => {
  const program = programFor(connection)
  const protocol = await readProtocol(program, address(need(values, 'protocol'), '--protocol'))
  const [entries, now] = await Promise.all([readEntries(program, protocol), clusterNow(connection)])
  const shown = values.all === true ? entries : entries.filter(({ entry }) => isLive(entry, now))

  if (values.json === true) {
    io.out(
      JSON.stringify(
        {
          protocol: protocol.address.toBase58(),
          authority: protocol.authority.toBase58(),
          clusterTime: now,
          entries: shown.map(({ seq, address: at, entry }) => ({
            seq,
            address: at.toBase58(),
            state: entryStateAt(entry, now),
            ...entry,
            ixDiscriminator: toHex(entry.ixDiscriminator),
          })),
        },
        null,
        2,
      ),
    )
    return 0
  }

  io.out(`protocol ${protocol.address.toBase58()}, authority ${protocol.authority.toBase58()}`)
  io.out(`cluster time ${isoOf(now)}`)
  const hidden = entries.length - shown.length
  if (shown.length === 0) io.out('no entries in force or pending')
  for (const numbered of shown) for (const line of describe(numbered, now)) io.out(line)
  if (hidden > 0) io.out(`(${hidden} revoked or expired not shown — --all)`)
  return 0
}

/** Exit status: 0 done, 1 refused or failed, 2 a command line that cannot be run. */
export const run = async (argv: readonly string[], io: Io): Promise<number> => {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    io.err(String(error instanceof Error ? error.message : error))
    io.err(USAGE)
    return 2
  }
  const { values, positionals } = parsed
  const [command, ...rest] = positionals
  if (values.help === true || command === undefined) {
    io.out(USAGE)
    return command === undefined && values.help !== true ? 2 : 0
  }
  if (rest.length > 0) {
    io.err(`unexpected: ${rest.join(' ')}`)
    return 2
  }

  try {
    const rpc = values.rpc ?? process.env.SOLANA_RPC_URL
    if (rpc === undefined || rpc === '') throw new UsageError('--rpc or SOLANA_RPC_URL is required')
    const connection = new Connection(rpc, { commitment: 'confirmed' })

    switch (command) {
      case 'submit':
        return await submit(values, connection, io)
      case 'narrow':
        return await revise(values, connection, io, true)
      case 'revoke':
        return await revise(values, connection, io, false)
      case 'list':
        return await list(values, connection, io)
      default:
        throw new UsageError(`unknown command ${command}`)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message)
      return 2
    }
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}
