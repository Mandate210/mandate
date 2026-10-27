import type { Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findPosition } from '@mandate/sdk'
import { getAccount } from '@solana/spl-token'
import type { Keypair } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type TestEnv,
  asset,
  setupTestEnv,
  validatorReachable,
  waitPastClusterTime,
} from './harness'
import {
  type RegisteredProtocol,
  completeWithdraw,
  deposit,
  ensureConfig,
  issuePolicy,
  registerProtocol,
  requestWithdraw,
} from './world'

const reachable = await validatorReachable()

/** A fraction kept exact: the reference must not round where the program does. */
interface Exact {
  readonly n: bigint
  readonly d: bigint
}

/** A loop, not recursion: fifty operations grow denominators past what the stack holds. */
const gcd = (a: bigint, b: bigint): bigint => {
  let [x, y] = [a, b]
  while (y !== 0n) [x, y] = [y, x % y]
  return x
}

const exact = (n: bigint, d = 1n): Exact => {
  const g = gcd(n < 0n ? -n : n, d)
  return { n: n / g, d: d / g }
}

const plus = (a: Exact, b: Exact): Exact => exact(a.n * b.d + b.n * a.d, a.d * b.d)
const minus = (a: Exact, b: Exact): Exact => exact(a.n * b.d - b.n * a.d, a.d * b.d)
const times = (a: Exact, b: Exact): Exact => exact(a.n * b.n, a.d * b.d)
/** `b` positive — every divisor here is a balance or a sum of them. */
const over = (a: Exact, b: Exact): Exact => exact(a.n * b.d, a.d * b.n)
const magnitude = (a: Exact): Exact => (a.n < 0n ? exact(-a.n, a.d) : a)
const below = (a: Exact, b: Exact): boolean => a.n * b.d < b.n * a.d
/** For messages only; every comparison stays exact. */
const approx = (a: Exact): number => Number((a.n * 10n ** 12n) / a.d) / 1e12

const UNDERWRITERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
type Name = (typeof UNDERWRITERS)[number]

type Step = { kind: 'deposit'; who: Name; amount: number } | { kind: 'premium'; amount: number }

interface Exit {
  who: Name
  /** The part of the position that leaves, as `[numerator, denominator]`. */
  part: readonly [bigint, bigint]
}

/**
 * Deposits and premiums in order, then the exits requested together, the premiums
 * sold while they wait, one wait, and the exits completed in the order requested.
 */
interface Round {
  steps: Step[]
  exits: Exit[]
  whileWaiting: number[]
}

const into = (who: Name, amount: number): Step => ({ kind: 'deposit', who, amount })
const premium = (amount: number): Step => ({ kind: 'premium', amount })
const out = (who: Name, numerator: bigint, denominator = 1n): Exit => ({
  who,
  part: [numerator, denominator],
})

/**
 * Fifty deposits and withdrawals among eight underwriters, with premiums between them.
 * Entries are staggered, positions grow and shrink, three underwriters leave entirely
 * and come back later, and every one of them is in the pool for at least one premium —
 * the measure below is relative to what each one should have earned, so nobody may
 * be owed nothing.
 */
const PLAN: Round[] = [
  {
    steps: [
      into('A', 50_000),
      into('B', 30_000),
      premium(1_200),
      into('C', 20_000),
      premium(900),
      into('D', 10_000),
      premium(600),
    ],
    exits: [out('B', 1n, 3n)],
    whileWaiting: [700],
  },
  {
    steps: [
      into('E', 40_000),
      premium(1_500),
      into('A', 15_000),
      into('F', 25_000),
      premium(1_100),
      into('C', 5_000),
      premium(400),
    ],
    exits: [out('A', 1n, 2n), out('D', 1n)],
    whileWaiting: [900],
  },
  {
    steps: [
      into('G', 60_000),
      premium(2_000),
      into('B', 12_000),
      into('H', 8_000),
      premium(700),
      into('E', 10_000),
      into('D', 20_000),
      premium(1_300),
    ],
    exits: [out('C', 1n, 4n), out('F', 2n, 3n), out('G', 1n, 5n)],
    whileWaiting: [500],
  },
  {
    steps: [
      into('A', 30_000),
      premium(900),
      into('H', 15_000),
      into('C', 7_000),
      premium(1_600),
      into('F', 9_000),
      into('B', 5_000),
      premium(300),
    ],
    exits: [out('E', 1n), out('H', 1n, 2n), out('A', 1n, 3n), out('B', 1n, 2n)],
    whileWaiting: [1_000],
  },
  {
    steps: [
      into('E', 35_000),
      premium(1_200),
      into('G', 18_000),
      into('D', 6_000),
      premium(800),
      into('C', 11_000),
      into('H', 4_000),
      into('A', 9_000),
      premium(1_400),
    ],
    exits: [out('D', 1n, 2n), out('C', 1n, 3n), out('G', 1n, 2n), out('F', 1n)],
    whileWaiting: [600],
  },
  {
    steps: [
      into('F', 22_000),
      premium(1_000),
      into('B', 16_000),
      into('E', 3_000),
      premium(700),
      into('H', 12_000),
      into('G', 5_000),
      into('C', 4_000),
      into('A', 2_000),
      premium(1_100),
    ],
    exits: [out('A', 1n, 4n), out('B', 1n, 3n), out('E', 1n, 2n), out('H', 1n, 3n), out('D', 1n)],
    whileWaiting: [900],
  },
]

/**
 * SC-010's yardstick, with no shares in it: each underwriter holds an exact amount,
 * a premium is split in proportion to the amounts held at that moment — capital
 * times time in the pool, one premium at a time — and an exit takes its part of the
 * amount held when it completes.
 */
const idealLedger = () => {
  const held = new Map<Name, Exact>(UNDERWRITERS.map((who) => [who, exact(0n)]))
  const received = new Map<Name, Exact>(UNDERWRITERS.map((who) => [who, exact(0n)]))
  const get = (book: Map<Name, Exact>, who: Name): Exact => book.get(who) ?? exact(0n)

  return {
    deposit(who: Name, amount: bigint): void {
      held.set(who, plus(get(held, who), exact(amount)))
    },
    premium(amount: bigint): void {
      const total = [...held.values()].reduce(plus, exact(0n))
      for (const [who, stake] of held) {
        held.set(who, plus(stake, times(exact(amount), over(stake, total))))
      }
    },
    exit(who: Name, [numerator, denominator]: readonly [bigint, bigint]): void {
      const leaving = times(get(held, who), exact(numerator, denominator))
      held.set(who, minus(get(held, who), leaving))
      received.set(who, plus(get(received, who), leaving))
    },
    /** Everything an underwriter has, taken or still in the pool. */
    worth(who: Name): Exact {
      return plus(get(received, who), get(held, who))
    },
  }
}

/** The worst underwriter's error relative to what they should have earned. */
const worstDeviation = (measured: Map<Name, Exact>, ideal: Map<Name, Exact>): Exact =>
  UNDERWRITERS.map((who) =>
    over(
      magnitude(minus(measured.get(who) ?? exact(0n), ideal.get(who) ?? exact(0n))),
      ideal.get(who) ?? exact(1n),
    ),
  ).reduce((worst, next) => (below(worst, next) ? next : worst))

const BUDGET = exact(1n, 1_000n)

/**
 * SC-010 on a live pool: the premiums fifty real deposits and withdrawals earned,
 * held against an exact reference (SPEC → SC-010, FR-018).
 *
 * The program never sees the reference. It keeps shares and rounds down on every
 * operation (PLAN → «Розподіл премій і ціна частки»); the reference keeps amounts and
 * never rounds. Agreement within 0.1% says that a share price is a faithful way to
 * split premiums by capital and time, and that fifty roundings do not add up to
 * anything. The control says the measure can tell: a split by capital alone, with the
 * time in the pool left out, has to miss by more than the budget on the same history.
 */
describe.skipIf(!reachable)('US2 — premium distribution (SC-010)', () => {
  let env: TestEnv
  let program: Program<DrainCover>

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
  })

  it('splits premiums by capital and time within 0.1% over fifty deposits and withdrawals', async () => {
    const operations = PLAN.reduce(
      (count, round) =>
        count + round.steps.filter((step) => step.kind === 'deposit').length + round.exits.length,
      0,
    )
    expect(operations).toBe(50)

    const target: RegisteredProtocol = await registerProtocol(program, env)
    const keys = new Map<Name, Keypair>()
    for (const who of UNDERWRITERS) keys.set(who, await env.fundedKeypair(2))
    const key = (who: Name): Keypair => {
      const found = keys.get(who)
      if (found === undefined) throw new Error(`no key for underwriter ${who}`)
      return found
    }
    const position = (who: Name) => findPosition(program.programId, target.pool, key(who).publicKey)
    const shares = async (who: Name): Promise<bigint> =>
      BigInt((await program.account.underwriterPosition.fetch(position(who))).shares.toString())

    const ideal = idealLedger()
    const deposited = new Map<Name, bigint>(UNDERWRITERS.map((who) => [who, 0n]))
    let premiums = 0n

    const sell = async (amount: number): Promise<void> => {
      // A small limit: the locked cover must never cap an exit (FR-020), or the
      // chain and the reference would be running different withdrawals.
      await issuePolicy(program, env, target, {
        limit: asset(1_000),
        retention: asset(100),
        premium: asset(amount),
      })
      ideal.premium(asset(amount))
      premiums += asset(amount)
    }

    for (const round of PLAN) {
      for (const step of round.steps) {
        if (step.kind === 'premium') {
          await sell(step.amount)
          continue
        }
        await deposit(program, env, target, asset(step.amount), key(step.who))
        ideal.deposit(step.who, asset(step.amount))
        deposited.set(step.who, (deposited.get(step.who) ?? 0n) + asset(step.amount))
      }

      let unlockedBy = 0
      for (const { who, part } of round.exits) {
        const [numerator, denominator] = part
        await requestWithdraw(
          program,
          target,
          key(who),
          ((await shares(who)) * numerator) / denominator,
        )
        const { unlockTs } = await program.account.underwriterPosition.fetch(position(who))
        unlockedBy = Math.max(unlockedBy, unlockTs.toNumber())
      }
      // Requested shares stay in the pool until they leave, so they earn these too.
      for (const amount of round.whileWaiting) await sell(amount)
      await waitPastClusterTime(env.connection, unlockedBy - 1)

      for (const { who, part } of round.exits) {
        await completeWithdraw(program, env, target, key(who))
        const left = await program.account.underwriterPosition.fetch(position(who))
        expect(left.pendingWithdraw.toString(), `${who}'s exit was cut short`).toBe('0')
        ideal.exit(who, part)
      }
    }

    // What the chain says each underwriter has: what reached their account, plus
    // their shares at the pool's exact price — no rounding added on the way out.
    const pool = await program.account.pool.fetch(target.pool)
    const totalAssets = BigInt(pool.totalAssets.toString())
    const totalShares = BigInt(pool.totalShares.toString())
    const received = new Map<Name, bigint>()
    for (const who of UNDERWRITERS) {
      const account = await env.assetAccount(key(who).publicKey)
      received.set(who, (await getAccount(env.connection, account)).amount)
    }

    // Nothing came in or went out but deposits, premiums and exits.
    const deposits = [...deposited.values()].reduce((a, b) => a + b, 0n)
    const paidOut = [...received.values()].reduce((a, b) => a + b, 0n)
    expect(totalAssets).toBe(deposits + premiums - paidOut)

    const earnedOnChain = new Map<Name, Exact>()
    const earnedIdeally = new Map<Name, Exact>()
    const earnedByCapitalAlone = new Map<Name, Exact>()
    for (const who of UNDERWRITERS) {
      const put = exact(deposited.get(who) ?? 0n)
      const stillIn = exact((await shares(who)) * totalAssets, totalShares)
      earnedOnChain.set(who, minus(plus(exact(received.get(who) ?? 0n), stillIn), put))
      earnedIdeally.set(who, minus(ideal.worth(who), put))
      earnedByCapitalAlone.set(who, exact(premiums * (deposited.get(who) ?? 0n), deposits))
    }

    // The premise of a relative measure: everyone was owed something.
    for (const who of UNDERWRITERS) {
      expect(below(exact(0n), earnedIdeally.get(who) ?? exact(0n)), `${who} earned nothing`).toBe(
        true,
      )
    }
    // The reference itself loses nothing: it hands out exactly the premiums.
    expect(
      UNDERWRITERS.map((who) => earnedIdeally.get(who) ?? exact(0n)).reduce(plus, exact(0n)),
    ).toEqual(exact(premiums))

    const deviation = worstDeviation(earnedOnChain, earnedIdeally)
    expect(below(deviation, BUDGET), `on-chain deviation ${approx(deviation)}`).toBe(true)

    const control = worstDeviation(earnedByCapitalAlone, earnedIdeally)
    expect(below(BUDGET, control), `capital-only deviation ${approx(control)}`).toBe(true)
  }, 600_000)
})
