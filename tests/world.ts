import { BN, type Program } from '@coral-xyz/anchor'
import { type DrainCover, PROGRAM_ID, findConfig } from '@drain-cover/sdk'
import { Connection, SystemProgram } from '@solana/web3.js'
import { type TestEnv, testRpcUrl } from './harness'

/**
 * Shared starting state for integration files.
 *
 * `Config` is a singleton per program id, so the suites cannot each build their own.
 * Rather than depending on file order — which Vitest does not promise — every file
 * either creates the config or accepts the one already there, and the tests that
 * genuinely need a virgin ledger say so and skip.
 */
export const CONFIG_PARAMS = {
  declarationDelay: 86_400,
  attestWindow: 2 * 3600,
  quorumBps: 6_000,
  openBond: 1_000_000,
} as const

export const configPresent = async (): Promise<boolean> => {
  const connection = new Connection(testRpcUrl(), 'confirmed')
  return (await connection.getAccountInfo(findConfig(PROGRAM_ID))) !== null
}

export const initializeConfig = (
  program: Program<DrainCover>,
  env: TestEnv,
  quorumBps: number = CONFIG_PARAMS.quorumBps,
): Promise<string> =>
  program.methods
    .initialize(
      new BN(CONFIG_PARAMS.declarationDelay),
      new BN(CONFIG_PARAMS.attestWindow),
      quorumBps,
      new BN(CONFIG_PARAMS.openBond),
    )
    .accountsPartial({
      admin: env.payer.publicKey,
      assetMint: env.assetMint,
      systemProgram: SystemProgram.programId,
    })
    .rpc()

/**
 * Creates the config if this validator has none. Safe to call from every file and in
 * any order: the admin and the mint come from constant seeds (`harness.ts`), so a
 * config created by one file leaves the others with the same rights and the same
 * settlement asset. Nothing has to skip, and nothing depends on file order.
 */
export const ensureConfig = async (program: Program<DrainCover>, env: TestEnv): Promise<void> => {
  if (await configPresent()) return
  await initializeConfig(program, env)
}
