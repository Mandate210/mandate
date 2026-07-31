import { getAccount, getMint } from '@solana/spl-token'
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { ASSET_DECIMALS, type TestEnv, asset, setupTestEnv, validatorReachable } from './harness'

// Proves the harness itself against a real validator: every later integration
// test builds its world out of these three helpers, so a silent failure here
// would surface as an unexplainable failure there.

const reachable = await validatorReachable()

describe.skipIf(!reachable)('harness against a live validator', () => {
  let env: TestEnv

  beforeAll(async () => {
    env = await setupTestEnv()
  })

  it('funds the payer', async () => {
    const balance = await env.connection.getBalance(env.payer.publicKey)
    expect(balance).toBeGreaterThan(50 * LAMPORTS_PER_SOL)
  })

  it('creates the settlement mint with the asset decimals', async () => {
    const mint = await getMint(env.connection, env.assetMint)
    expect(mint.decimals).toBe(ASSET_DECIMALS)
    expect(mint.mintAuthority?.equals(env.payer.publicKey)).toBe(true)
    // No freeze authority: a frozen vault is R-4, and the harness should not add
    // a second way to reach that state on top of the issuer's.
    expect(mint.freezeAuthority).toBeNull()
  })

  it('funds a fresh keypair on request', async () => {
    const other = await env.fundedKeypair(2)
    const balance = await env.connection.getBalance(other.publicKey)
    expect(balance).toBe(2 * LAMPORTS_PER_SOL)
  })

  it('credits a token account with whole units of the asset', async () => {
    const owner = Keypair.generate().publicKey
    const account = await env.assetAccount(owner, asset(1_500))
    const balance = await getAccount(env.connection, account)
    expect(balance.amount).toBe(asset(1_500))
    expect(balance.owner.equals(owner)).toBe(true)
  })

  it('reuses the associated token account for the same owner', async () => {
    const owner = Keypair.generate().publicKey
    const first = await env.assetAccount(owner, asset(10))
    const second = await env.assetAccount(owner, asset(5))
    expect(second.equals(first)).toBe(true)
    const balance = await getAccount(env.connection, first)
    expect(balance.amount).toBe(asset(15))
  })
})
