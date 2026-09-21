// The end-to-end scenario (T028): a compromise happens, and the system pays out
// without anybody touching it.
//
//   pnpm --filter @mandate/scenarios compromise
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
import { createActor } from '@mandate/attestor/act'
import { createChain, toObservedTransaction } from '@mandate/attestor/chain'
import { type WatchedAddress, connectionWatchRpc, createWatcher } from '@mandate/attestor/watch'
import {
  type DrainCover,
  createProgram,
  findAttestor,
  findConfig,
  findIncident,
} from '@mandate/sdk'
import { base58Decode } from '@mandate/shared'
import {
  type TestEnv,
  asset,
  clusterTimestamp,
  setupTestEnv,
  waitForNextEpoch,
  waitPastClusterTime,
} from '@mandate/tests/harness'
import {
  type RegisteredProtocol,
  fundPool,
  issuePolicy,
  quorumNeeded,
  registerProtocol,
  revokeDeclaration,
  setAttestor,
} from '@mandate/tests/world'
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  createMultisig,
  getAssociatedTokenAddressSync,
  mintTo,
} from '@solana/spl-token'
import { Keypair, type PublicKey, SystemProgram } from '@solana/web3.js'
import {
  COMPROMISES,
  type Compromise,
  type CompromiseWorld,
  LEGITIMATE,
  UNIT,
  sendWith,
} from './compromises'
import { decodeKeypair, readState, secondsPerSlot, setupDevnetEnv } from './devnet'

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

/**
 * SOL an attestor holds for a run, whichever cluster it is on.
 *
 * It pays rent for the incidents it opens (~0.0022 each) and for its own attestations
 * (~0.0010 each), plus fees — under 0.05 SOL across eleven stages. On a validator this
 * could be any number at all; devnet is the reason it is this one.
 */
const ATTESTOR_SOL = 0.15

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
const ensureScenarioConfig = async (program: Program<DrainCover>, env: TestEnv): Promise<void> => {
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
  const token = await createMint(env.connection, env.payer, privilegedAddress, privilegedAddress, 6)
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
  } else {
    await mintTo(
      env.connection,
      env.payer,
      token,
      treasury,
      privilegedAddress,
      10_000 * UNIT,
      members,
    )
  }
  // Only the scenario that sweeps native balance needs any, and it says how much.
  // Airdropped on a validator and transferred on devnet, where two SOL a stage would
  // cost more than a whole run can afford.
  if (compromise.needsSol !== undefined) {
    await env.fund(privilegedAddress, compromise.needsSol)
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
    send: (instructions, signers) => sendWith(env.connection, env.payer, instructions, signers),
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
): Promise<{
  settled: boolean
  seconds: number
  received: bigint
  note: string
  incident: PublicKey | null
}> => {
  const started = Date.now()
  const beneficiary = getAssociatedTokenAddressSync(env.assetMint, target.treasury, true)
  const before = await balanceOf(env, beneficiary)

  for (;;) {
    const raised = await incidentForTrigger(program, target.protocol, signature)

    if (raised !== null && 'paidOut' in raised.account.status) {
      const seconds = (Date.now() - started) / 1000
      const received = (await balanceOf(env, beneficiary)) - before
      return {
        settled: received > 0n,
        seconds,
        received,
        note: received > 0n ? '' : 'settled without moving any money to the beneficiary',
        incident: raised.address,
      }
    }
    if (Date.now() - started > budgetSeconds * 1000) {
      const note =
        raised === null
          ? 'no incident was ever opened'
          : `incident opened, no quorum — ${raised.account.votesUnauthorized} vote(s) unauthorized`
      return {
        settled: false,
        seconds: (Date.now() - started) / 1000,
        received: 0n,
        note,
        incident: raised?.address ?? null,
      }
    }
    await sleep(400)
  }
}

/**
 * The incident this protocol carries for this trigger signature — singular, by
 * construction.
 *
 * Two earlier versions of this are worth remembering. The first looked at sequence
 * number zero and asked whether *that* incident had paid out; on devnet, where the
 * attestors race on essentially every event, the quorum often landed on a second
 * incident at sequence one and the scenario reported «not recognised» for a compromise
 * that was recognised and paid. The second enumerated every incident of the protocol
 * and filtered by the stored signature. Since T070 the address *is* the signature, so
 * this is one derivation and one read — and «how many incidents did this event get»
 * stops being a question, which is what `incidentCount` below is checked for.
 */
const incidentForTrigger = async (
  program: Program<DrainCover>,
  protocol: PublicKey,
  signature: string,
): Promise<{
  address: PublicKey
  account: { status: object; votesUnauthorized: number }
} | null> => {
  const address = findIncident(program.programId, protocol, base58Decode(signature))
  const account = await program.account.incident.fetchNullable(address)
  return account === null ? null : { address, account }
}

/** `Protocol.incident_count`: every incident ever opened against it, duplicates included. */
const incidentsOpenedOn = async (
  program: Program<DrainCover>,
  protocol: PublicKey,
): Promise<number> => (await program.account.protocol.fetch(protocol)).incidentCount.toNumber()

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

  return (
    '1'.repeat(zeros) +
    digits
      .reverse()
      .map((digit) => BASE58[digit])
      .join('')
  )
}

/**
 * Attestors admitted for a run of this scenario, and the epoch wait that FR-008 forces.
 *
 * Only reachable on a validator started with `--slots-per-epoch 32`. A devnet epoch is
 * 432 000 slots, so admitting a set there and waiting for it takes about thirty-two
 * hours — which is why the devnet entry point reuses a set admitted in an earlier
 * session instead of calling this.
 */
const admitFreshSet = async (program: Program<DrainCover>, env: TestEnv): Promise<Keypair[]> => {
  const attestorKeys: Keypair[] = []
  for (let index = 0; index < ATTESTOR_COUNT; index += 1) {
    const keypair = await env.fundedKeypair(ATTESTOR_SOL)
    await setAttestor(program, env, keypair.publicKey)
    attestorKeys.push(keypair)
  }
  await waitForNextEpoch(env.connection)
  return attestorKeys
}

/**
 * The scenario itself, from an empty world to the two criteria.
 *
 * Takes its environment and its attestors rather than making them, because those are
 * the only two things devnet does differently: money there is transferred instead of
 * airdropped, and the attestor set has to have been admitted an epoch earlier. Every
 * judgement below is the same on both, which is the point — a devnet run that shared
 * none of this code would be evidence about a different program.
 */
export const runScenario = async ({
  program,
  env,
  attestorKeys,
  cluster,
}: {
  program: Program<DrainCover>
  env: TestEnv
  /** Already in the set and already able to vote in the current epoch. */
  attestorKeys: Keypair[]
  /** Set on a public cluster, so every payout can be printed as a link somebody
   * outside this process can open. That link is half of what M1 promises to show. */
  cluster?: 'devnet'
}): Promise<void> => {
  // **Can these workers carry a quorum at all.**
  //
  // The set is global to the deployment and the denominator is whatever `Config` says,
  // not how many workers this run happens to start. Re-running the scenario on a ledger
  // that already has a set admits three more, so the bar rises while the number of
  // voters does not — and every sample then waits out its full budget in silence. Ten
  // stages at three minutes each is half an hour of a run that could never have worked.
  // `--reset` between runs is what `CLAUDE.md` prescribes; this is what says so when it
  // was skipped.
  const config = await program.account.config.fetch(findConfig(program.programId))
  const needed = quorumNeeded(config.attestorCount, config.quorumBps)
  if (needed > attestorKeys.length) {
    throw new Error(
      `The set on this deployment is ${config.attestorCount} attestors, so a quorum needs ${needed} votes — and this run has only ${attestorKeys.length} workers. No incident could ever be resolved. On a validator, restart it with --reset (CLAUDE.md → Commands); on devnet, the set in devnet-state.json is smaller than the one Config counts.`,
    )
  }

  say(`staging ${COMPROMISES.length} protocols, one per compromise, plus the control…`)
  const stages: Stage[] = []
  for (const compromise of COMPROMISES) {
    stages.push(await buildStage(program, env, compromise))
  }
  const control = await buildStage(program, env, LEGITIMATE)
  for (const stage of [...stages, control]) await stage.compromise.prepare?.(stage.world)
  say(`  ${stages.length + 1} staged\n`)

  for (const attestor of attestorKeys) {
    // Enough bond for every incident this attestor might be the one to open, plus fees.
    await env.assetAccount(attestor.publicKey, BigInt(OPEN_BOND) * BigInt(stages.length + 2))
    await env.fund(attestor.publicKey, ATTESTOR_SOL)
  }
  say(`${attestorKeys.length} attestors active\n`)

  const watched: WatchedAddress[] = [...stages, control].map((stage) => ({
    protocol: stage.target.protocol.toBase58(),
    address: stage.world.privilegedAddress.toBase58(),
  }))

  const watchers = attestorKeys.map((attestor) => {
    const provider = new AnchorProvider(env.connection, new Wallet(attestor), {
      commitment: 'confirmed',
    })
    const actor = createActor({
      chain: createChain({
        program: createProgram(provider),
        connection: env.connection,
        attestor,
      }),
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
      say(
        `waiting ${lastEffective - now + 1}s of cluster time for the declarations to take effect…`,
      )
      await waitPastClusterTime(env.connection, lastEffective)
    }
  }

  // Far enough past the staging that no sweep can reach back into it.
  await sleep(2_000)
  for (const watcher of watchers) await watcher.start()
  say(`${watchers.length} attestor workers watching ${watched.length} privileged addresses\n`)

  const results: {
    id: string
    recognised: boolean
    seconds: number
    received: bigint
    incident: PublicKey | null
    signature: string
    /** Incidents the protocol counted for this one event. One is the only right answer. */
    opened: number
  }[] = []

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
    const opened = await incidentsOpenedOn(program, stage.target.protocol)
    results.push({
      id: stage.compromise.id,
      recognised: decision.settled,
      seconds: decision.seconds,
      received: decision.received,
      incident: decision.incident,
      signature,
      opened,
    })
    say(
      decision.settled
        ? `recognised, ${Number(decision.received) / UNIT} paid in ${decision.seconds.toFixed(1)}s${opened === 1 ? '' : ` — ${opened} INCIDENTS OPENED`}`
        : `NOT RECOGNISED after ${decision.seconds.toFixed(0)}s — ${decision.note}`,
    )
  }

  // The control, last: by now the workers have opened ten incidents, so if anything is
  // going to make them open an eleventh out of habit, it has had every chance.
  process.stdout.write(`  ${control.compromise.id.padEnd(36)} `)
  const controlSignature = await control.compromise.fire(control.world)
  await sleep(CONTROL_WINDOW_SECONDS * 1_000)
  // The counter, not just the control's own address: an incident on this protocol about
  // *any* transaction — the scaffolding touches the privileged key too — is a false
  // opening, and the counter sees all of them where a single derived address would not.
  const controlOpened = await incidentsOpenedOn(program, control.target.protocol)
  const controlIncident = await program.account.incident.fetchNullable(
    findIncident(program.programId, control.target.protocol, base58Decode(controlSignature)),
  )
  const controlHeld = controlOpened === 0
  say(
    controlHeld
      ? `left alone for ${CONTROL_WINDOW_SECONDS}s, as it should be`
      : controlIncident !== null
        ? 'FALSE INCIDENT — a declared operation was treated as a compromise'
        : `FALSE INCIDENT — ${controlOpened} opened on the control protocol, on a transaction other than the control`,
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

  if (cluster !== undefined) {
    // The other half of what M1 shows: somebody outside this process opening the
    // incident and reading the payout for themselves.
    say('\non chain:')
    for (const result of results) {
      if (result.incident === null) continue
      say(
        `  ${result.id.padEnd(36)} https://explorer.solana.com/address/${result.incident.toBase58()}?cluster=${cluster}`,
      )
    }
  }

  say('\n────────────────────────────────────────────────')
  say(
    `SC-003  recognised ${recognised.length} of ${results.length}   (needs ≥ ${REQUIRED_RECOGNISED})`,
  )
  say(
    `T070    incidents per event ${results.map((result) => result.opened).join(' ')}   (needs 1 each)`,
  )
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
    failures.push(
      `SC-005: slowest cycle ${slowest.toFixed(1)}s over the ${CYCLE_BUDGET_SECONDS}s budget`,
    )
  }
  if (!controlHeld) {
    // Without this the count above is not recall — it is the score of a system that
    // might be opening an incident on everything it sees.
    failures.push('control: an incident was opened on a declared operation')
  }
  const duplicated = results.filter((result) => result.opened > 1)
  if (duplicated.length > 0) {
    // T070. Before the incident was addressed by its trigger, three attestors racing
    // on one event opened two or three incidents for it on devnet — 22 of 45 triggers.
    // Every extra one held a bond and kept the pool's capital frozen for good.
    failures.push(
      `T070: more than one incident on one event — ${duplicated
        .map((result) => `${result.id} (${result.opened})`)
        .join(', ')}`,
    )
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAILED  ${failure}`)
    process.exit(1)
  }
  say('\nboth criteria met.')
  process.exit(0)
}

/**
 * The devnet setup: the same scenario, two things the cluster decides differently.
 *
 * Money is transferred rather than airdropped, and the attestor set is **reused, never
 * admitted** — FR-008 lets an attestor vote from the epoch after the one it joined in,
 * and a devnet epoch is 432 000 slots, about thirty-two hours. Admitting a set here
 * would hang the demonstration for a day and a half.
 *
 * `Config` is checked and never created: it is a singleton whose parameters are fixed
 * forever, and devnet has no `--reset` to undo a wrong one.
 */
const setupOnDevnet = async (): Promise<{
  env: TestEnv
  program: Program<DrainCover>
  attestorKeys: Keypair[]
}> => {
  const env = await setupDevnetEnv()
  const program = createProgram(env.provider)

  const state = readState()
  if (state === null || state.attestors.length === 0) {
    throw new Error(
      'No devnet-state.json with attestors. Run `pnpm --filter @mandate/scenarios devnet:setup` first, then wait for the next epoch.',
    )
  }

  const config = await program.account.config.fetchNullable(findConfig(program.programId))
  if (config === null) throw new Error('No Config on this cluster. Run devnet:setup first.')
  if (config.declarationDelay.toNumber() !== DECLARATION_DELAY) {
    throw new Error(
      `This deployment's declaration delay is ${config.declarationDelay.toNumber()}s and the scenario needs ${DECLARATION_DELAY}s. Config is a singleton fixed at creation and devnet has no --reset, so this cannot be corrected here — only under a new program id.`,
    )
  }

  const attestorKeys = state.attestors.map(decodeKeypair)
  const { epoch } = await env.connection.getEpochInfo()
  const memberships = await program.account.attestor.fetchMultiple(
    attestorKeys.map((attestor) => findAttestor(program.programId, attestor.publicKey)),
  )
  const active = memberships.filter(
    (attestor) => attestor?.inSet && attestor.activeFromEpoch.toNumber() <= epoch,
  ).length
  const needed = Math.ceil((config.attestorCount * config.quorumBps) / 10_000)

  if (active < needed) {
    const info = await env.connection.getEpochInfo()
    const hours =
      ((info.slotsInEpoch - info.slotIndex) * (await secondsPerSlot(env.connection))) / 3_600
    throw new Error(
      `Only ${active} of ${attestorKeys.length} attestors can vote in epoch ${epoch}, and a quorum of the set of ${config.attestorCount} needs ${needed}. FR-008 admits an attestor from the epoch after the one it was admitted in, and this epoch has about ${hours.toFixed(1)}h to run. Nothing to fix — wait.`,
    )
  }

  say(
    `epoch ${epoch}: ${active} attestors can vote, quorum needs ${needed} of ${config.attestorCount}\n`,
  )
  return { env, program, attestorKeys }
}

const setupOnValidator = async (): Promise<{
  env: TestEnv
  program: Program<DrainCover>
  attestorKeys: Keypair[]
}> => {
  const env = await setupTestEnv()
  const program = createProgram(env.provider)

  await ensureScenarioConfig(program, env)
  say('admitting attestors…')
  const attestorKeys = await admitFreshSet(program, env)

  return { env, program, attestorKeys }
}

const main = async (): Promise<void> => {
  const onDevnet = process.argv.includes('--devnet')

  say(`mandate — compromise scenario (T028), ${onDevnet ? 'devnet' : 'local validator'}\n`)
  const { env, program, attestorKeys } = onDevnet ? await setupOnDevnet() : await setupOnValidator()

  await runScenario({
    program,
    env,
    attestorKeys,
    ...(onDevnet ? { cluster: 'devnet' as const } : {}),
  })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
