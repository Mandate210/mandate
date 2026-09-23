// Sweeping incidents the attestation window left behind (T071, FR-011, FR-019).
//
// `close_expired_incident` has existed on chain since T021 and **nothing called it**.
// On devnet that left 17 open incidents sitting on their votes with no quorum, each
// holding a reservation on its pool's capital; `FR-019` blocks an underwriter's
// withdrawal while any incident on the pool is open, so without this module US2 walks
// into a wall. The migration in T070 had to sweep 23 of them with a throwaway script.
//
// **This is housekeeping, not attestation.** Nothing here forms a judgement: every
// action is one the program would take from public state alone, and the instructions
// it sends take no signer at all — `resolve` and `close_expired_incident` are both
// permissionless precisely because they release capital, and nobody may be in a
// position to withhold that. The sweeper lives in the attestor because the attestor is
// the one process in the system that already holds a key, an RPC and a program client
// — not because sweeping is an attestor's privilege. Anyone may run it, and an
// underwriter whose capital is frozen has the strongest reason to.
//
// **`resolve` belongs here too, and not only after the deadline.** `act.ts` pays out
// on the attestation that completes the quorum, and when that `resolve` fails it logs
// and moves on — by design, because every way it loses is a race. But if it lost to
// something other than a race, nobody comes back: the incident sits at quorum until
// its deadline and then closes *with no payout*. The decision taken, the money not
// sent. `resolve` has no deadline of its own (`handle_resolve`), so a sweep catches
// that the moment it sees it.
//
// The decision itself is a pure function, tested against the same boundaries as the
// Rust guards it mirrors. Everything that touches an RPC is behind `SweepChain`, so
// the whole module runs against a fake on a machine with no validator and no network —
// the rule `pnpm gate` is built on (`CLAUDE.md` → «Two test suites, on purpose»).

/** Basis points denominator, as `BPS_DENOMINATOR` in the program. */
const BPS_DENOMINATOR = 10_000

/** `Incident`, narrowed to what a sweep decision needs. */
export interface SweepIncident {
  /** The incident account, base58. */
  address: string
  /** The protocol it belongs to — its seeds and its pool come from this. */
  protocol: string
  /** The policy account the incident was opened against. */
  policy: string
  /** Whoever posted the bond; paid back or forfeited on close. */
  opener: string
  /** `opened_at + Config::attest_window`. */
  deadline: number
  /** The attestor set as it stood when the incident opened — this quorum's denominator. */
  setSize: number
  votesUnauthorized: number
}

/** `Policy`, narrowed to what a sweep decision and a payout need. */
export interface SweepPolicy {
  startTs: number
  endTs: number
  premiumPaid: bigint
  /** `PolicyStatus::Exhausted` — the one status that is not a function of the clock. */
  exhausted: boolean
  /** Fixed at issuance (FR-004); `resolve` pays here and cannot create the account. */
  beneficiary: string
}

export type SweepAction =
  /** Quorum reached on a policy still in force: pay it out (FR-012). */
  | 'resolve'
  /** The window closed on something `resolve` can no longer settle (FR-011). */
  | 'close'
  /** Neither is admissible yet; the next pass looks again. */
  | 'wait'

/**
 * The bar this incident's quorum has to clear.
 *
 * `set_size` as the incident recorded it, never the current one, and the share rounded
 * **up** — exactly as `quorum_threshold` does it in the program. Rounding down would
 * let a set of three clear a 60% quorum on one attestation.
 */
export const quorumThreshold = (setSize: number, quorumBps: number): number =>
  Math.ceil((setSize * quorumBps) / BPS_DENOMINATOR)

/**
 * Whether the policy covers an event at `now` — `Policy::is_in_force`.
 *
 * The period is the truth, not the stored status: no instruction wakes up on a start
 * or end date, so a status can only be as fresh as the last transaction that touched
 * the account. Only `Exhausted` is read, because that one is not a function of time.
 */
export const policyInForce = (policy: SweepPolicy, now: number): boolean =>
  !policy.exhausted && policy.premiumPaid > 0n && now >= policy.startTs && now < policy.endTs

/**
 * What to do with one open incident.
 *
 * A mirror of two guards, and it has to stay one: `handle_resolve` (open, policy in
 * force, quorum reached — and no deadline condition at all) and `validate_close`
 * (open, `now > deadline`, and not something `resolve` would still pay). Disagreeing
 * with either costs a refused transaction, not a wrong outcome — the program remains
 * the authority — but a sweeper that disagrees systematically is a sweeper that never
 * sweeps, which is the bug this task exists to fix.
 *
 * **The deadline is strict.** `attest` counts an attestation landing in the deadline
 * second as inside the window, so closing may only start the second after. Reading the
 * boundary the other way would have the sweeper spend a fee to be refused, once per
 * pass, on every incident in its last second.
 */
export const decideSweepAction = ({
  incident,
  policy,
  quorumBps,
  now,
}: {
  incident: SweepIncident
  /** `null` when the policy account is gone — nothing to judge in force. */
  policy: SweepPolicy | null
  quorumBps: number
  now: number
}): SweepAction => {
  const quorumReached = incident.votesUnauthorized >= quorumThreshold(incident.setSize, quorumBps)
  const inForce = policy !== null && policyInForce(policy, now)

  // Before the deadline as well: an incident at quorum is owed a payout now, and the
  // only thing that had to happen first — the attestations — has happened.
  if (quorumReached && inForce) return 'resolve'
  if (now > incident.deadline) return 'close'
  return 'wait'
}

/**
 * Why an incident that is due cannot be acted on.
 *
 * Both instructions take the accounts they pay into as live `TokenAccount`s, and
 * neither can create one. Anchor deserialises them before the handler runs, so the
 * account has to exist even where nothing is transferred into it. Reported as a state
 * rather than retried as an error: nothing about the next pass will be different, and
 * an operator reading `blocked` learns what to do — open the account — where a stack
 * trace every ten minutes tells them only that something is wrong.
 *
 * Neither is necessarily permanent. A blocked payout unblocks itself once the policy
 * falls out of force: `resolve` no longer applies and the incident closes on its
 * deadline like any other.
 */
export type BlockedReason =
  /**
   * The opener has no account for the settlement asset.
   *
   * `close_expired_incident` needs `opener_token` in **both** branches, including the
   * one that forfeits the bond and transfers nothing. An opener who closed the account
   * it paid its bond from leaves an incident nobody can close and a pool whose capital
   * stays reserved — the one case here with no way out but intervention.
   */
  | 'opener-token-missing'
  /**
   * The policy's beneficiary has no account for the settlement asset.
   *
   * `resolve` pays into it and cannot open it, so a beneficiary without one is a policy
   * that was issued wrong (FR-004 fixes the beneficiary at issuance). Measured, not
   * imagined: the first run of the one-shot command against a live ledger hit exactly
   * this and would otherwise have reported it as a failure once per pass forever.
   */
  | 'beneficiary-token-missing'

export interface SweepReport {
  /** Open incidents the filter returned. */
  scanned: number
  resolved: string[]
  closed: string[]
  /** Still inside their window, or waiting for a deadline to make them closable. */
  waiting: number
  /** Acted on by somebody else between the read and the write. Not a failure. */
  lost: string[]
  blocked: { incident: string; reason: BlockedReason }[]
  failed: { incident: string; error: unknown }[]
}

/**
 * The chain surface a sweep uses, and nothing more.
 *
 * Narrow for the same reason `ActChain` and `WatchRpc` are: it is what lets the sweep
 * be tested without a validator.
 */
export interface SweepChain {
  /** Every incident still taking attestations, for every registered protocol. */
  listOpenIncidents(): Promise<SweepIncident[]>
  loadPolicy(policy: string): Promise<SweepPolicy | null>
  /** `Config::quorum_bps`. One read per pass; it changes about never. */
  quorumBps(): Promise<number>
  /** Whether this owner has an account for the settlement asset. */
  settlementAccountExists(owner: string): Promise<boolean>
  /** Whether the incident is still taking attestations. */
  incidentOpen(incident: string): Promise<boolean>
  /** Records the quorum and pays out in one operation (FR-012). Permissionless. */
  resolve(protocol: string, incident: string): Promise<void>
  /** Closes with no payout and releases the pool's reservation (FR-011). Permissionless. */
  closeExpired(protocol: string, incident: string): Promise<void>
}

export interface SweepLogger {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

const silentLogger: SweepLogger = { info: () => {}, warn: () => {}, error: () => {} }

export interface Sweeper {
  /** One pass over every open incident. Safe to call at any time; never overlaps. */
  sweepOnce(): Promise<SweepReport>
  /** Sweeps now, then every `intervalSeconds`. */
  start(): Promise<void>
  stop(): void
}

export interface SweeperOptions {
  chain: SweepChain
  logger?: SweepLogger
  /**
   * Seconds between passes.
   *
   * Ten minutes by default, the same interval as the watcher's reconcile: nothing here
   * is urgent. A closed incident releases a reservation that only matters to a
   * withdrawal, and withdrawals have a waiting period of their own (FR-019). The one
   * time-sensitive case — an incident at quorum whose payout did not land — is the
   * fallback under `act.ts`, not the path SC-001 is measured on.
   */
  intervalSeconds?: number
  /**
   * Seconds, wall clock. Machine time, deliberately: the program decides with
   * `Clock::get`, and a machine clock that drifts only costs a refused transaction —
   * which preflight declines before it reaches the chain, so it costs nothing at all.
   * The same convention as `findPolicyInForce` in `chain.ts`.
   */
  now?: () => number
}

export const DEFAULT_SWEEP_INTERVAL_SECONDS = 600

export const createSweeper = ({
  chain,
  logger = silentLogger,
  intervalSeconds = DEFAULT_SWEEP_INTERVAL_SECONDS,
  now = () => Math.floor(Date.now() / 1000),
}: SweeperOptions): Sweeper => {
  let timer: ReturnType<typeof setInterval> | null = null
  let sweeping = false

  /**
   * Send one instruction and classify how it went.
   *
   * A failure is diagnosed by re-reading the incident rather than by picking apart the
   * error, the same choice `act.ts` makes: the expected way to lose here is that
   * another sweeper — another attestor, an underwriter, anyone — acted on the same
   * incident in the seconds since the listing, and that outcome is the one this module
   * wanted. Matching on error codes would be one refactor of the program away from
   * swallowing a real fault.
   *
   * Losing costs nothing: the transaction is refused at preflight and never reaches
   * the chain, which is why there is no staggering between attestors here. Jitter was
   * removed from opening in T070 for the same reason.
   */
  /** `null` when the instruction can be sent, otherwise what stands in its way. */
  const blockedReason = async (
    incident: SweepIncident,
    action: 'resolve' | 'close',
    policy: SweepPolicy | null,
  ): Promise<BlockedReason | null> => {
    if (!(await chain.settlementAccountExists(incident.opener))) return 'opener-token-missing'
    if (action === 'resolve' && policy !== null) {
      if (!(await chain.settlementAccountExists(policy.beneficiary))) {
        return 'beneficiary-token-missing'
      }
    }
    return null
  }

  const act = async (
    incident: SweepIncident,
    action: 'resolve' | 'close',
    report: SweepReport,
  ): Promise<void> => {
    try {
      if (action === 'resolve') await chain.resolve(incident.protocol, incident.address)
      else await chain.closeExpired(incident.protocol, incident.address)
    } catch (error) {
      if (!(await chain.incidentOpen(incident.address))) {
        report.lost.push(incident.address)
        return
      }
      report.failed.push({ incident: incident.address, error })
      logger.error({ incident: incident.address, action, error }, 'sweep action failed')
      return
    }

    if (action === 'resolve') report.resolved.push(incident.address)
    else report.closed.push(incident.address)
    logger.info(
      { incident: incident.address, protocol: incident.protocol },
      action === 'resolve' ? 'quorum found unsettled, paid out' : 'expired incident closed',
    )
  }

  const sweepOnce = async (): Promise<SweepReport> => {
    const report: SweepReport = {
      scanned: 0,
      resolved: [],
      closed: [],
      waiting: 0,
      lost: [],
      blocked: [],
      failed: [],
    }

    if (sweeping) return report
    sweeping = true

    try {
      const [incidents, quorumBps] = await Promise.all([
        chain.listOpenIncidents(),
        chain.quorumBps(),
      ])
      report.scanned = incidents.length
      const at = now()

      const due: {
        incident: SweepIncident
        action: 'resolve' | 'close'
        policy: SweepPolicy | null
      }[] = []
      for (const incident of incidents) {
        const policy = await chain.loadPolicy(incident.policy)
        const action = decideSweepAction({ incident, policy, quorumBps, now: at })
        if (action === 'wait') report.waiting += 1
        else due.push({ incident, action, policy })
      }

      // Payouts first, and oldest first within each kind. An incident that is both at
      // quorum and past its deadline has to reach `resolve` before anything closes it
      // — `close_expired_incident` refuses that one (`IncidentPayable`), but only
      // while the policy holds, and a policy can lapse between two instructions.
      due.sort((left, right) =>
        left.action === right.action
          ? left.incident.deadline - right.incident.deadline
          : left.action === 'resolve'
            ? -1
            : 1,
      )

      for (const { incident, action, policy } of due) {
        // Checked before the write, not diagnosed after it: the accounts these
        // instructions pay into have to exist, nothing about the next pass would
        // change that, and a state in the report beats the same error every ten
        // minutes. Both instructions need the opener's; only `resolve` pays a
        // beneficiary, so that one is read only when there is a payout to make.
        const blocked = await blockedReason(incident, action, policy)
        if (blocked !== null) {
          report.blocked.push({ incident: incident.address, reason: blocked })
          logger.warn(
            { incident: incident.address, reason: blocked },
            'incident cannot be settled: an account it pays into does not exist',
          )
          continue
        }
        await act(incident, action, report)
      }
    } finally {
      sweeping = false
    }

    return report
  }

  return {
    sweepOnce,

    async start(): Promise<void> {
      logger.info({ intervalSeconds }, 'sweeping expired incidents')
      await sweepOnce()
      timer = setInterval(() => {
        void sweepOnce().catch((error: unknown) => {
          // A pass that throws outright — an RPC that will not answer — must not take
          // the attestor down with it: watching for the next compromise matters more
          // than this pass, and the next pass is ten minutes away.
          logger.error({ error }, 'sweep pass failed')
        })
      }, intervalSeconds * 1000)
      // The worker's lifetime is decided by its caller, not by this timer.
      timer.unref()
    },

    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

/** One line for a log or a console: what a pass actually did. */
export const summariseSweep = (report: SweepReport): string =>
  [
    `scanned ${report.scanned}`,
    `resolved ${report.resolved.length}`,
    `closed ${report.closed.length}`,
    `waiting ${report.waiting}`,
    `lost ${report.lost.length}`,
    `blocked ${report.blocked.length}`,
    `failed ${report.failed.length}`,
  ].join(' · ')
