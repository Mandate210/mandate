// One-time, irreversible setup of the devnet deployment (T029, first half).
//
//   pnpm --filter @drain-cover/scenarios devnet:setup
//
// Idempotent: safe to re-run after a devnet hiccup, and it says what it found rather
// than recreating it. What it cannot do is undo — `Config` is a singleton PDA with no
// instruction to change its parameters, and devnet has no `--reset`. Everything this
// script writes into it is fixed for the life of the deployment.
//
// **Why this is a separate script from the measurement.** An attestor admitted in one
// epoch votes from the next (FR-008), and a devnet epoch is 432 000 slots — about
// thirty-two hours, against roughly thirteen seconds on a validator started the way
// `CLAUDE.md` prescribes. So the set has to be admitted well before anything can be
// measured, and the honest shape of that is two runs with a wait between them rather
// than one script that appears to hang for a day and a half.

import { BN } from '@coral-xyz/anchor'
import { createProgram, findAttestor, findConfig } from '@drain-cover/sdk'
import { setAttestor } from '@drain-cover/tests/world'
import { Keypair, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js'
import {
  decodeKeypair,
  encodeKeypair,
  readState,
  secondsPerSlot,
  setupDevnetEnv,
  writeState,
} from './devnet'

/**
 * The declaration delay this deployment lives with, in seconds.
 *
 * Thirty seconds where FR-031 says twenty-four hours, and the choice is permanent
 * because `Config` is. The reasoning, and what has to be said out loud when this
 * deployment is demonstrated, is in `docs/deploy-devnet.md` → «Що фіксується назавжди».
 */
const DECLARATION_DELAY = 30
/** Matches `tests/world.ts` and the local scenario, so a run here is comparable. */
const ATTEST_WINDOW = 90
const QUORUM_BPS = 6_000
const OPEN_BOND = 1_000_000

/** Three, so the quorum is two of three — the smallest set where the deciding vote
 * comes from somebody other than whoever opened the incident. */
const ATTESTOR_COUNT = 3

/**
 * Enough for every attestation account this attestor will pay rent for, plus fees.
 *
 * An attestation costs about 0.00101 SOL of rent that never comes back, and one of the
 * three also pushes every `resolve`. A tenth of a SOL covers a run several times over
 * and still leaves the payer the bulk of what it holds.
 */
const ATTESTOR_SOL = 0.1

/** Bonds for more incidents than any one run will open. */
const ATTESTOR_BOND_UNITS = 40n

const say = (message: string): void => {
  console.log(message)
}

const main = async (): Promise<void> => {
  const env = await setupDevnetEnv()
  const program = createProgram(env.provider)

  say('drain-cover — devnet setup (T029)\n')
  say(`payer   ${env.payer.publicKey.toBase58()}`)
  say(`balance ${(await env.connection.getBalance(env.payer.publicKey)) / LAMPORTS_PER_SOL} SOL`)
  say(`mint    ${env.assetMint.toBase58()}\n`)

  // ── Config ────────────────────────────────────────────────────────────────────
  const configAddress = findConfig(program.programId)
  const existing = await program.account.config.fetchNullable(configAddress)

  if (existing === null) {
    say('creating Config — this fixes admin, asset mint and every duration forever…')
    await program.methods
      .initialize(new BN(DECLARATION_DELAY), new BN(ATTEST_WINDOW), QUORUM_BPS, new BN(OPEN_BOND))
      .accountsPartial({
        admin: env.payer.publicKey,
        assetMint: env.assetMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
    say(`  created at ${configAddress.toBase58()}\n`)
  } else {
    // Read back rather than assumed: this script is idempotent, and the one way it
    // could silently do damage is by admitting attestors into a deployment whose
    // parameters are not the ones the measurement is calibrated for.
    if (existing.declarationDelay.toNumber() !== DECLARATION_DELAY) {
      throw new Error(
        `Config already exists with a declaration delay of ${existing.declarationDelay.toNumber()}s, and this script is written for ${DECLARATION_DELAY}s. Config is a singleton whose parameters are fixed at creation and devnet has no --reset, so this cannot be corrected — only redeployed under a new program id.`,
      )
    }
    if (!existing.assetMint.equals(env.assetMint)) {
      throw new Error(
        `Config's asset mint is ${existing.assetMint.toBase58()}, but devnet-state.json names ${env.assetMint.toBase58()}. One of the two belongs to a different deployment.`,
      )
    }
    say(`Config already exists — delay ${existing.declarationDelay.toNumber()}s, window ${existing.attestWindow.toNumber()}s, quorum ${existing.quorumBps} bps, set of ${existing.attestorCount}\n`)
  }

  // ── Attestors ─────────────────────────────────────────────────────────────────
  const state = readState()
  if (state === null) throw new Error('devnet-state.json vanished between two reads.')

  const attestors = state.attestors.map(decodeKeypair)
  while (attestors.length < ATTESTOR_COUNT) attestors.push(Keypair.generate())

  // Written before they are used, not after: a key that has been funded and admitted
  // but not recorded is SOL spent on an attestor nobody can ever vote with.
  writeState({ ...state, attestors: attestors.map(encodeKeypair) })

  const epoch = (await env.connection.getEpochInfo()).epoch
  say(`admitting ${attestors.length} attestors — current epoch ${epoch}…`)

  for (const attestor of attestors) {
    await env.fund(attestor.publicKey, ATTESTOR_SOL)
    await env.assetAccount(attestor.publicKey, ATTESTOR_BOND_UNITS * BigInt(OPEN_BOND))

    const account = await program.account.attestor.fetchNullable(
      findAttestor(program.programId, attestor.publicKey),
    )
    if (account?.inSet) {
      say(`  ${attestor.publicKey.toBase58()}  already in the set from epoch ${account.activeFromEpoch.toString()}`)
      continue
    }
    await setAttestor(program, env, attestor.publicKey)
    const admitted = await program.account.attestor.fetch(
      findAttestor(program.programId, attestor.publicKey),
    )
    say(`  ${attestor.publicKey.toBase58()}  votes from epoch ${admitted.activeFromEpoch.toString()}`)
  }

  // ── When can anything be measured ─────────────────────────────────────────────
  const info = await env.connection.getEpochInfo()
  const remaining = info.slotsInEpoch - info.slotIndex
  const hours = (remaining * (await secondsPerSlot(env.connection))) / 3_600

  say('')
  say('────────────────────────────────────────────────')
  say(`epoch ${info.epoch}, ${remaining} of ${info.slotsInEpoch} slots left`)
  say(`the set votes from epoch ${info.epoch + 1} — about ${hours.toFixed(1)}h away`)
  say('────────────────────────────────────────────────')
  say('')
  say('FR-008 is why: an attestor admitted in one epoch votes from the next, and a')
  say('devnet epoch is 432 000 slots. Run the measurement after the boundary:')
  say('')
  say('  pnpm --filter @drain-cover/scenarios devnet:measure')

  const left = await env.connection.getBalance(env.payer.publicKey)
  say(`\npayer has ${(left / LAMPORTS_PER_SOL).toFixed(4)} SOL left`)
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
