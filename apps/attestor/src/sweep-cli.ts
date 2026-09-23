// One sweep pass, then exit (T071).
//
// The other half of `sweep.ts`: the attestor runs the sweep on a timer, and this runs
// it once on demand. Both exist for a reason the devnet migration in T070 made
// concrete — 23 incidents had to be closed by hand with a throwaway script, because a
// worker that nobody had written yet is the same thing as a worker that is not running.
//
// Every instruction it sends is permissionless, so this needs no attestor identity:
// `SWEEPER_KEYPAIR` is whatever key is willing to pay the fee, and an underwriter whose
// capital `FR-019` has frozen has the best reason of anyone to spend it. It falls back
// to `ATTESTOR_KEYPAIR` so that an operator who already has an attestor configured can
// run it with no extra setup.
//
// Exit status is for a cron: non-zero when a human should look — an incident that could
// not be settled, or one nothing can settle.

import { AnchorProvider, Wallet } from '@coral-xyz/anchor'
import { createProgram } from '@mandate/sdk'
import { base58Decode } from '@mandate/shared'
import { Connection, Keypair } from '@solana/web3.js'
import { createSweepChain } from './chain'
import { createSweeper, summariseSweep } from './sweep'

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

/** Base58 secret key from the environment, never a path (`docs/PLAN.md` → Безпека). */
const loadPayer = (): Keypair => {
  const name = process.env.SWEEPER_KEYPAIR ? 'SWEEPER_KEYPAIR' : 'ATTESTOR_KEYPAIR'
  const bytes = base58Decode(required(name))
  if (bytes.length !== 64) {
    throw new Error(`${name} must be a base58 secret key of 64 bytes, got ${bytes.length}`)
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes))
}

const main = async (): Promise<void> => {
  const payer = loadPayer()
  const connection = new Connection(required('SOLANA_RPC_URL'), { commitment: 'confirmed' })
  const program = createProgram(
    new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' }),
  )

  console.log(`sweeping as ${payer.publicKey.toBase58()}`)
  const report = await createSweeper({
    chain: createSweepChain({ program, connection }),
  }).sweepOnce()

  for (const incident of report.resolved) console.log(`  paid out  ${incident}`)
  for (const incident of report.closed) console.log(`  closed    ${incident}`)
  for (const incident of report.lost)
    console.log(`  taken     ${incident} (settled by someone else)`)
  for (const { incident, reason } of report.blocked)
    console.error(`  BLOCKED   ${incident}: ${reason}`)
  for (const { incident, error } of report.failed) console.error(`  FAILED    ${incident}:`, error)

  console.log(summariseSweep(report))

  // A blocked incident is not a failed run, but it is capital that stays reserved until
  // somebody intervenes — so it gets the same attention as a failure.
  if (report.failed.length > 0 || report.blocked.length > 0) process.exit(1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
