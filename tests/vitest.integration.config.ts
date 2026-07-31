import { defineConfig } from 'vitest/config'

// Integration tests are `*.itest.ts` and need a running solana-test-validator, so
// they are kept out of the default `vitest run` — `pnpm gate` and the CI
// `typescript` job must stay green on a machine with no validator and no Rust.
// `anchor test` boots the validator and runs this config (Anchor.toml → [scripts]).
export default defineConfig({
  test: {
    include: ['**/*.itest.ts'],
    // One validator, shared state: parallel files would race over the same
    // Config PDA and the same airdrop faucet.
    fileParallelism: false,
    // Airdrops, mint creation and confirmations are slower than the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
