// The end-to-end scenario (T028): a compromise happens, and the system pays out
// without anybody touching it.
//
//   pnpm --filter @drain-cover/scenarios compromise
//
// Needs a validator started the way the integration suite needs one — `--reset` and
// `--slots-per-epoch 32` (`CLAUDE.md` → Commands). `--reset` is not optional here for a
// second reason on top of the usual one: this scenario runs with a **short declaration
// delay**, and `Config` fixes that forever at creation, so a ledger carrying the
// integration suite's config cannot run it.
//
// **Why the delay is shortened, and what that costs.** FR-031's delay is 24 hours in the
// product, and every entry a protocol files takes effect only after it. Three of the ten
// scenarios turn on that boundary — one acts before an entry takes effect, one after the
// protocol withdrew it, one alongside an entry that is genuinely in force — and none of
// them is reachable inside a three-minute demonstration at 24 hours. Thirty seconds
// keeps the boundary real and the run finite. It is the same compromise `attestWindow`
// already makes in the test config, and it is a property of the demonstration, not of
// the system.
//
// **Two criteria, measured separately.**
//   SC-005 — the full cycle, compromise to money in the treasury, without manual
//   intervention, in under three minutes. Measured on the wall clock from the moment the
//   offending transaction confirms.
//   SC-003 — at least nine of the ten reproduced compromises recognised, meaning an
//   incident opened and a quorum reaching «unauthorized».
//
// Nothing in the loop is scripted. The scenario stages the world, starts real attestor
// workers, and then only fires transactions: the watching, the verdict, the incident,
// the attestations and the payout are the workers' own doing, which is the whole claim
// SC-005 makes.

import { AnchorProvider, BN, type Program, Wallet } from '@coral-xyz/anchor'
import { createActor } from '@drain-cover/attestor/act'
import { createChain, toObservedTransaction } from '@drain-cover/attestor/chain'
import { type WatchedAddress, connectionWatchRpc, createWatcher } from '@drain-cover/attestor/watch'
import { type DrainCover, createProgram, findConfig, findIncident } from '@drain-cover/sdk'
import {
  asset,
  clusterTimestamp,
  setupTestEnv,
  type TestEnv,
  waitForNextEpoch,
  waitPastClusterTime,
} from '@drain-cover/tests/harness'
import {
  fundPool,
  issuePolicy,
  type RegisteredProtocol,
  registerProtocol,
  revokeDeclaration,
  setAttestor,
} from '@drain-cover/tests/world'
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  createMultisig,
  getAssociatedTokenAddressSync,
  mintTo,
} from '@solana/spl-token'
import { Keypair, LAMPORTS_PER_SOL, type PublicKey, SystemProgram } from '@solana/web3.js'
import {
  COMPROMISES,
  type Compromise,
  type CompromiseWorld,
  LEGITIMATE,
  UNIT,
  sendWith,
} from './compromises'

/** Thirty seconds where the product parameter is a day — see the note at the top. */
const DECLARATION_DELAY = 30
const ATTEST_WINDOW = 90
const QUORUM_BPS = 6_000
const OPEN_BOND = 1_000_000

/** SC-005. */
const CYCLE_BUDGET_SECONDS = 180
/** SC-003: nine of ten. */
const REQUIRED_RECOGNISED = 9
/** How long the control is given to be wrongly recognised. Ten times what a real
 * recognition takes on this cluster, so a quiet result is a decision and not a race. */
const CONTROL_WINDOW_SECONDS = 15

/**
 * Three, so the quorum is two of three.
 *
 * The smallest set that would clear a 60% quorum is one attestor voting alone, and a
 * scenario built on that would demonstrate nothing this system is for: no second
 * opinion, no race between attestors to open the same incident, and the attestation
 * that completes the quorum is always the one that opened it. Three is the smallest set
 * where the deciding vote comes from somebody other than the opener.
 */
const ATTESTOR_COUNT = 3

const POOL_CAPITAL = asset(100_000)
const POLICY_LIMIT = asset(10_000)
const POLICY_RETENTION = asset(500)
const POLICY_PREMIUM = asset(100)

/** The scenario reads as a narrative in the terminal, so this is deliberately plain. */
const say = (message: string): void => {
  console.log(message)
}

const quiet = {
  info: () => {},
  warn: () => {},
  error: (fields: Record<string, unknown>, message: string) => {
    // Anchor puts the account that failed a constraint in the program logs and nowhere
    // else, so a scenario that printed only the error code would leave the next person
    // guessing between eight accounts.
    const error = fields.error
    const logs =
      error !== null && typeof error === 'object' && 'logs' in error
        ? (error as { logs?: string[] }).logs
        : undefined
    console.error(`\n  ! ${message}`, error)
    if (logs) for (const line of logs.slice(-8)) console.error(`      ${line}`)
  },
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `Config` is a singleton and its parameters are fixed at creation, so a ledger that
 * already carries one from another suite cannot run this. Said plainly rather than
 * failing later on a confusing timing assertion.
 */
const ensureScenarioConfig = async (
  program: Program<DrainCover>,
  env: TestEnv,
): Promise<void> => {
  const existing = await program.account.config.fetchNullable(findConfig(program.programId))
  if (existing !== null) {
    if (existing.declarationDelay.toNumber() !== DECLARATION_DELAY) {
      throw new Error(
        `This ledger's config has a declaration delay of ${existing.declarationDelay.toNumber()}s, and the scenario needs ${DECLARATION_DELAY}s. Config is a singleton and its parameters are fixed forever at creation — restart the validator with --reset.`,
      )
    }
    return
  }

  await program.methods
    .initialize(new BN(DECLARATION_DELAY), new BN(ATTEST_WINDOW), QUORUM_BPS, new BN(OPEN_BOND))
    .accountsPartial({
      admin: env.payer.publicKey,
      assetMint: env.assetMint,
      systemProgram: SystemProgram.programId,
    })
    .rpc()
}

interface Stage {
  compromise: Compromise
  target: RegisteredProtocol
  world: CompromiseWorld
}

/**
 * One protocol per scenario, and one policy on it.
 *
 * Not tidiness: a policy whose limit is fully paid becomes `Exhausted`, so a second
 * incident could not be opened against it (`resolve` → FR-015). Ten scenarios sharing
 * one policy would measure the first one and then nine refusals. Separate protocols also
 * keep the declarations apart, which three of the scenarios depend on.
 */
const buildStage = async (
  program: Program<DrainCover>,
  env: TestEnv,
  compromise: Compromise,
): Promise<Stage> => {
  const attacker = Keypair.generate()
  const members = [Keypair.generate(), Keypair.generate()]

  // The multisig scenario's privileged address has no key anywhere — which is the whole
  // point of it, and what the involvement branch of the rule exists for.
  const usesMultisig = compromise.id === 'multisig-executed-drain'
  const privileged = usesMultisig ? null : Keypair.generate()
  const privilegedAddress = usesMultisig
    ? await createMultisig(
        env.connection,
        env.payer,
        members.map((member) => member.publicKey),
        2,
      )
    : (privileged as Keypair).publicKey

  const target = await registerProtocol(program, env, [privilegedAddress])
  await fundPool(program, env, target, POOL_CAPITAL)
  await issuePolicy(program, env, target, {
    limit: POLICY_LIMIT,
    retention: POLICY_RETENTION,
    premium: POLICY_PREMIUM,
  })
  // `resolve` pays the beneficiary and cannot create its account, so it has to exist
  // before an incident is ever opened.
  await env.assetAccount(target.treasury)

  // A token the privileged address is the authority over — the protocol's own asset.
  const token = await createMint(
    env.connection,
    env.payer,
    privilegedAddress,
    privilegedAddress,
    6,
  )
  const treasury = await createAssociatedTokenAccountIdempotent(
    env.connection,
    env.payer,
    token,
    privilegedAddress,
    { commitment: 'confirmed' },
    undefined,
    undefined,
    true,
  )
  const pocket = await createAssociatedTokenAccountIdempotent(
    env.connection,
    env.payer,
    token,
    attacker.publicKey,
    { commitment: 'confirmed' },
  )
  // Minted by the payer? No — the mint authority is the privileged address, so the
  // scaffolding has to be signed by whatever can sign for it. The multisig scenario
  // does not need a balance minted this way; its members can sign.
  if (privileged !== null) {
    await mintTo(env.connection, env.payer, token, treasury, privileged, 10_000 * UNIT)
    // `lamport-drain` moves native balance out of the privileged account, so there has
    // to be some there to move.
    await env.connection.confirmTransaction(
      await env.connection.requestAirdrop(privilegedAddress, 2 * LAMPORTS_PER_SOL),
      'confirmed',
    )
  } else {
    await mintTo(env.connection, env.payer, token, treasury, privilegedAddress, 10_000 * UNIT, members)
  }

  const world: CompromiseWorld = {
    connection: env.connection,
    payer: env.payer,
    privileged,
    privilegedAddress,
    attacker,
    members,
    token,
    treasury,
    pocket,
    declare: async ({ programId, discriminator, movesFunds = true }) => {
      const now = await clusterTimestamp(env.connection)
      const seq = (
        await program.account.protocol.fetch(target.protocol)
      ).nextDeclarationSeq.toNumber()

      await program.methods
        .submitDeclaration(
          programId,
          discriminator,
          new BN(now - 60),
          new BN(now + 40 * 86_400),
          movesFunds,
        )
        .accountsPartial({
          protocol: target.protocol,
          authority: target.authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([target.authority])
        .rpc()

      return seq
    },
    revoke: (seq) => revokeDeclaration(program, target, seq),
    send: (instructions, signers) =>
      sendWith(env.connection, env.payer, instructions, signers),
  }

  return { compromise, target, world }
}

/**
 * Waits for the incident raised **by this transaction** to settle, or gives up.
 *
 * The trigger signature is checked, not assumed. Any transaction touching the
 * privileged address is grounds for an incident, and the scaffolding around a scenario
 * touches it plenty — so an incident that merely exists proves nothing about whether
 * the compromise was the thing that was recognised. Reading `trigger_sig` back is what
 * makes a green result mean what it says.
 *
 * The payout is read from the beneficiary's balance rather than from the incident's own
 * `payout` field, for the same reason: the field records what the program intended to
 * send, and SC-005 is about money that arrived.
 */
const awaitDecision = async (
  program: Program<DrainCover>,
  env: TestEnv,
  target: RegisteredProtocol,
  signature: string,
  budgetSeconds: number,
): Promise<{ settled: boolean; seconds: number; received: bigint; note: string }> => {
  const started = Date.now()
  const address = findIncident(program.programId, target.protocol, 0)
  const beneficiary = getAssociatedTokenAddressSync(env.assetMint, target.treasury, true)
  const before = await balanceOf(env, beneficiary)

  for (;;) {
    const incident = await program.account.incident.fetchNullable(address)
    if (incident !== null && 'paidOut' in incident.status) {
      const seconds = (Date.now() - started) / 1000
      const triggered = bs58(incident.triggerSig)
      if (triggered !== signature) {
        return {
          settled: false,
          seconds,
          received: 0n,
          note: `incident was raised by ${triggered.slice(0, 12)}…, not by the compromise`,
        }
      }
      const received = (await balanceOf(env, beneficiary)) - before
      return {
        settled: received > 0n,
        seconds,
        received,
        note: received > 0n ? '' : 'settled without moving any money to the beneficiary',
      }
    }
    if (Date.now() - started > budgetSeconds * 1000) {
      const note =
        incident === null
          ? 'no incident was ever opened'
          : `incident stayed open with ${incident.votesUnauthorized} of the votes it needed`
      return { settled: false, seconds: (Date.now() - started) / 1000, received: 0n, note }
    }
    await sleep(400)
  }
}

const balanceOf = async (env: TestEnv, account: PublicKey): Promise<bigint> => {
  const info = await env.connection.getTokenAccountBalance(account, 'confirmed')
  return BigInt(info.value.amount)
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** The 64 stored bytes back into the signature a block explorer would show. */
const bs58 = (bytes: number[]): string => {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1

  const digits: number[] = []
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index] as number
    for (let digit = 0; digit < digits.length; digit += 1) {
      carry += (digits[digit] as number) << 8
      digits[digit] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  return '1'.repeat(zeros) + digits.reverse().map((digit) => BASE58[digit]).join('')
}

const main = async (): Promise<void> => {
  const env = await setupTestEnv()
  const program = createProgram(env.provider)

  say('drain-cover — compromise scenario (T028)\n')
  await ensureScenarioConfig(program, env)

  say(`staging ${COMPROMISES.length} protocols, one per compromise, plus the control…`)
  const stages: Stage[] = []
  for (const compromise of COMPROMISES) {
    stages.push(await buildStage(program, env, compromise))
  }
  const control = await buildStage(program, env, LEGITIMATE)
  for (const stage of [...stages, control]) await stage.compromise.prepare?.(stage.world)
  say(`  ${stages.length + 1} staged\n`)

  say('admitting attestors…')
  const attestorKeys: Keypair[] = []
  for (let index = 0; index < ATTESTOR_COUNT; index += 1) {
    const keypair = await env.fundedKeypair(5)
    await setAttestor(program, env, keypair.publicKey)
    attestorKeys.push(keypair)
  }
  for (const attestor of attestorKeys) {
    // Enough bond for every incident this attestor might be the one to open, plus fees.
    await env.assetAccount(attestor.publicKey, BigInt(OPEN_BOND) * BigInt(stages.length + 2))
    await env.connection.confirmTransaction(
      await env.connection.requestAirdrop(attestor.publicKey, 5 * LAMPORTS_PER_SOL),
      'confirmed',
    )
  }
  // FR-008: admitted in one epoch, voting from the next.
  await waitForNextEpoch(env.connection)
  say(`  ${attestorKeys.length} attestors active\n`)

  const watched: WatchedAddress[] = [...stages, control].map((stage) => ({
    protocol: stage.target.protocol.toBase58(),
    address: stage.world.privilegedAddress.toBase58(),
  }))

  const watchers = attestorKeys.map((attestor) => {
    const provider = new AnchorProvider(env.connection, new Wallet(attestor), {
      commitment: 'confirmed',
    })
    const actor = createActor({
      chain: createChain({ program: createProgram(provider), connection: env.connection, attestor }),
      logger: quiet,
    })
    return createWatcher({
      rpc: connectionWatchRpc(env.connection),
      watched,
      logger: quiet,
      // The scaffolding above is history by now, and an attestor starting here should
      // judge what happens next — not the mint it was handed on the way in.
      policy: { startupLookbackSeconds: 0, reconcileSeconds: 15, pollSeconds: 5 },
      onTransaction: (transaction) => actor.act(transaction).then(() => undefined),
    })
  })

  // **Wait for the declarations to actually take effect, on the cluster's clock.**
  //
  // Three scenarios and the control turn on an entry being in force, and «enough time
  // has surely passed by now» is not a fact about the cluster: its clock runs at its own
  // pace, and on this validator it lags the wall clock badly enough that a 30-second
  // delay had not elapsed after 35 seconds of real time. The first run of this scenario
  // fired the control 7 cluster-seconds early and read the resulting incident as a false
  // positive by the matcher — when the matcher had been right and the scenario wrong.
  //
  // Worse, and quieter: `drain-behind-a-declared-operation` and `acting-after-revocation`
  // were passing for the wrong reason. Their entries were not in force either, so the
  // operations were undeclared outright and neither scenario tested the thing it is named
  // after. A scenario that passes for the wrong reason is worse than one that fails.
  const filed = await createChain({
    program,
    connection: env.connection,
    attestor: env.payer,
  })
  const effectiveAt = await Promise.all(
    [...stages, control].map(async (stage) =>
      (await filed.loadDeclaration(stage.target.protocol.toBase58())).reduce(
        (latest, entry) => Math.max(latest, entry.effectiveAt),
        0,
      ),
    ),
  )
  const lastEffective = Math.max(...effectiveAt, 0)
  if (lastEffective > 0) {
    const now = await clusterTimestamp(env.connection)
    if (lastEffective >= now) {
      say(`waiting ${lastEffective - now + 1}s of cluster time for the declarations to take effect…`)
      await waitPastClusterTime(env.connection, lastEffective)
    }
  }

  // Far enough past the staging that no sweep can reach back into it.
  await sleep(2_000)
  for (const watcher of watchers) await watcher.start()
  say(`${watchers.length} attestor workers watching ${watched.length} privileged addresses\n`)

  const results: { id: string; recognised: boolean; seconds: number; received: bigint }[] = []

  for (const stage of stages) {
    process.stdout.write(`  ${stage.compromise.id.padEnd(36)} `)
    const signature = await stage.compromise.fire(stage.world)
    const decision = await awaitDecision(
      program,
      env,
      stage.target,
      signature,
      CYCLE_BUDGET_SECONDS,
    )
    results.push({
      id: stage.compromise.id,
      recognised: decision.settled,
      seconds: decision.seconds,
      received: decision.received,
    })
    say(
      decision.settled
        ? `recognised, ${Number(decision.received) / UNIT} paid in ${decision.seconds.toFixed(1)}s`
        : `NOT RECOGNISED after ${decision.seconds.toFixed(0)}s — ${decision.note}`,
    )
  }

  // The control, last: by now the workers have opened ten incidents, so if anything is
  // going to make them open an eleventh out of habit, it has had every chance.
  process.stdout.write(`  ${control.compromise.id.padEnd(36)} `)
  const controlSignature = await control.compromise.fire(control.world)
  await sleep(CONTROL_WINDOW_SECONDS * 1_000)
  const controlIncident = await program.account.incident.fetchNullable(
    findIncident(program.programId, control.target.protocol, 0),
  )
  const controlHeld = controlIncident === null
  say(
    controlHeld
      ? `left alone for ${CONTROL_WINDOW_SECONDS}s, as it should be`
      : 'FALSE INCIDENT — a declared operation was treated as a compromise',
  )
  if (controlIncident !== null) {
    // A false opening is the one failure this scenario cannot leave as a number: which
    // transaction was blamed, and what the protocol had actually declared, is the whole
    // of the diagnosis.
    const blamed = bs58(controlIncident.triggerSig)
    say(`      blamed:  ${blamed}`)
    say(`      fired:   ${controlSignature}`)
    const fetched = await env.connection.getTransaction(blamed, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
    const observed = fetched === null ? null : toObservedTransaction(blamed, fetched)
    if (observed !== null) {
      for (const [index, instruction] of observed.instructions.entries()) {
        say(
          `      ix ${index}: ${instruction.programId} data=[${instruction.data.slice(0, 4).join(',')}…] depth=${instruction.stackHeight}`,
        )
      }
    }
    const declared = await createChain({
      program,
      connection: env.connection,
      attestor: env.payer,
    }).loadDeclaration(control.target.protocol.toBase58())
    const at = observed?.blockTime ?? 0
    for (const entry of declared) {
      say(
        `      entry: ${entry.programId} disc=[${entry.ixDiscriminator.slice(0, 2).join(',')}…] effectiveAt=${entry.effectiveAt} (tx at ${at}, ${at - entry.effectiveAt}s after)`,
      )
    }
  }

  for (const watcher of watchers) await watcher.stop()

  const recognised = results.filter((result) => result.recognised)
  const slowest = Math.max(...recognised.map((result) => result.seconds), 0)

  say('\n────────────────────────────────────────────────')
  say(`SC-003  recognised ${recognised.length} of ${results.length}   (needs ≥ ${REQUIRED_RECOGNISED})`)
  say(
    `SC-005  slowest full cycle ${slowest.toFixed(1)}s          (needs ≤ ${CYCLE_BUDGET_SECONDS}s)`,
  )
  say('────────────────────────────────────────────────')

  const failures: string[] = []
  if (recognised.length < REQUIRED_RECOGNISED) {
    failures.push(
      `SC-003: ${recognised.length} of ${results.length} recognised — ${results
        .filter((result) => !result.recognised)
        .map((result) => result.id)
        .join(', ')}`,
    )
  }
  if (recognised.length === 0 || slowest > CYCLE_BUDGET_SECONDS) {
    failures.push(`SC-005: slowest cycle ${slowest.toFixed(1)}s over the ${CYCLE_BUDGET_SECONDS}s budget`)
  }
  if (!controlHeld) {
    // Without this the count above is not recall — it is the score of a system that
    // might be opening an incident on everything it sees.
    failures.push('control: an incident was opened on a declared operation')
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAILED  ${failure}`)
    process.exit(1)
  }
  say('\nboth criteria met.')
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
