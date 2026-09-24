import { AnchorError, BN, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findPosition } from '@mandate/sdk'
import { getAccount } from '@solana/spl-token'
import { SystemProgram } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, asset, setupTestEnv, validatorReachable } from './harness'
import {
  type RegisteredProtocol,
  deposit,
  ensureConfig,
  fundPool,
  issuePolicy,
  registerProtocol,
} from './world'

const reachable = await validatorReachable()

/**
 * Capital from outside, priced in shares (FR-017, T030).
 *
 * Every pool here is registered by this file, because the price of a share is the
 * pool's whole history: a suite depositing into a pool another file had funded would
 * be asserting against numbers it does not control.
 */
describe.skipIf(!reachable)('deposit', () => {
  let env: TestEnv
  let program: Program<DrainCover>

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
  })

  it('opens a position and prices the first deposit one for one', async () => {
    const target = await registerProtocol(program, env)
    const { underwriter, position } = await deposit(program, env, target, asset(100_000))

    const pool = await program.account.pool.fetch(target.pool)
    const vault = await getAccount(env.connection, pool.vault)
    const held = await program.account.underwriterPosition.fetch(position)

    expect(vault.amount).toBe(asset(100_000))
    expect(BigInt(pool.totalAssets.toString())).toBe(asset(100_000))
    expect(BigInt(pool.totalShares.toString())).toBe(asset(100_000))
    expect(BigInt(held.shares.toString())).toBe(asset(100_000))
    // Nothing on the way out yet: both of these belong to T032.
    expect(held.pendingWithdraw.toNumber()).toBe(0)
    expect(held.unlockTs.toNumber()).toBe(0)
    // The position is this underwriter's, and its address is what says so.
    expect(position).toEqual(findPosition(program.programId, target.pool, underwriter.publicKey))
  })

  it('adds a second deposit to the same position', async () => {
    const target = await registerProtocol(program, env)
    const { underwriter, position } = await deposit(program, env, target, asset(100_000))
    await deposit(program, env, target, asset(50_000), underwriter)

    const pool = await program.account.pool.fetch(target.pool)
    const held = await program.account.underwriterPosition.fetch(position)

    expect(BigInt(pool.totalShares.toString())).toBe(asset(150_000))
    expect(BigInt(held.shares.toString())).toBe(asset(150_000))
  })

  /**
   * FR-018 on chain, and the reason there is no separate premium ledger: the premium
   * is already in `total_assets`, so it is already in the price of a share. The
   * second underwriter pays that price, and the difference is what the first earned.
   */
  it('makes a share cost more once the pool has earned a premium', async () => {
    const target = await registerProtocol(program, env)
    const first = await deposit(program, env, target, asset(100_000))
    // Ten per cent of the pool, arriving as the premium on a policy it backs.
    await issuePolicy(program, env, target, {
      limit: asset(50_000),
      retention: asset(1_000),
      premium: asset(10_000),
    })

    const second = await deposit(program, env, target, asset(110_000))

    const pool = await program.account.pool.fetch(target.pool)
    const firstHeld = await program.account.underwriterPosition.fetch(first.position)
    const secondHeld = await program.account.underwriterPosition.fetch(second.position)

    // 110 000 at 1.1 assets per share is 100 000 shares: ten per cent more money for
    // the same holding the first underwriter has.
    expect(BigInt(secondHeld.shares.toString())).toBe(asset(100_000))
    expect(BigInt(firstHeld.shares.toString())).toBe(asset(100_000))
    expect(BigInt(pool.totalAssets.toString())).toBe(asset(220_000))
    expect(BigInt(pool.totalShares.toString())).toBe(asset(200_000))

    // Said the other way round: the first underwriter's shares are now worth the
    // premium the pool earned while they were the only one in it.
    const worth =
      (BigInt(firstHeld.shares.toString()) * BigInt(pool.totalAssets.toString())) /
      BigInt(pool.totalShares.toString())
    expect(worth).toBe(asset(110_000))
  })

  it('refuses a deposit too small to be worth a share', async () => {
    const target = await registerProtocol(program, env)
    await deposit(program, env, target, asset(100_000))
    await issuePolicy(program, env, target, {
      limit: asset(50_000),
      retention: asset(1_000),
      premium: asset(10_000),
    })

    // A share now costs 1.1 base units, so one base unit buys none of it.
    const error = await depositFails(program, env, target, 1n)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('DepositTooSmall')
  })

  /**
   * The pool the US1 demo funds through `service_fund_pool` holds capital no share
   * represents. Pricing a first deposit one for one there would hand all of it to
   * whoever arrived first, so the program refuses — which is the same statement as
   * "that instruction cannot survive into US2" (T036).
   */
  it('refuses a first deposit into a pool seeded by the service path', async () => {
    const target = await registerProtocol(program, env)
    await fundPool(program, env, target, asset(10_000))

    const error = await depositFails(program, env, target, asset(1_000))

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('PoolHasUnsharedCapital')
  })

  it('refuses a zero amount', async () => {
    const target = await registerProtocol(program, env)

    const error = await depositFails(program, env, target, 0n)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('AmountMustBePositive')
  })

  /**
   * Shares go to the address that signed, and to no other. The position's address is
   * derived from that address (FR-017), so crediting someone else's would mean
   * passing a PDA the seeds do not produce.
   */
  it('will not credit the shares to another address position', async () => {
    const target = await registerProtocol(program, env)
    const underwriter = await env.fundedKeypair(2)
    const other = await env.fundedKeypair(1)
    const source = await env.assetAccount(underwriter.publicKey, asset(1_000))

    const error = await program.methods
      .deposit(new BN(asset(1_000).toString()))
      .accountsPartial({
        underwriter: underwriter.publicKey,
        protocol: target.protocol,
        pool: target.pool,
        position: findPosition(program.programId, target.pool, other.publicKey),
        vault: target.vault,
        source,
        systemProgram: SystemProgram.programId,
      })
      .signers([underwriter])
      .rpc()
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('ConstraintSeeds')
  })
})

/** The failure of a deposit as a value: the helper throws, and here that is the point. */
const depositFails = (
  program: Program<DrainCover>,
  env: TestEnv,
  target: RegisteredProtocol,
  amount: bigint,
): Promise<unknown> => deposit(program, env, target, amount).catch((thrown: unknown) => thrown)
