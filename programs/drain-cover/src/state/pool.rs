use anchor_lang::prelude::*;

use crate::errors::DrainCoverError;

pub const POOL_SEED: &[u8] = b"pool";

/// Capital underwriting exactly one covered protocol, and the only source of its
/// payouts (FR-002). Isolation is structural: each pool owns its own vault, so
/// there is no shared store to draw from by mistake.
///
/// **A share is a claim on a fraction of `total_assets`, not on a fixed amount.**
/// Everything that moves capital moves the value of a share with it: a premium
/// raises it (FR-018), a payout lowers it (FR-015). That is what makes both
/// proportional to holding and to time in the pool without a second ledger —
/// nothing accrued before a deposit is claimable, because the deposit was priced
/// against a pool that already held it.
///
/// An earlier design carried premiums separately in an `acc_premium_per_share`
/// accumulator while `issue_policy` also credited them to `total_assets`, which
/// counted every premium twice: the pool would have owed more than it held. The
/// accumulator cannot be the answer on its own either — a pool that pays claims
/// has to be able to lose principal, and a share priced at a fixed amount has
/// nowhere to record that loss.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// Token account holding the capital, owned by this PDA.
    pub vault: Pubkey,
    /// What the pool owns, as the program recorded it — never the vault balance.
    /// A stray transfer into the vault must not become backing for a policy, and
    /// open incidents' bonds sit in the vault outside this number (T018).
    pub total_assets: u64,
    pub total_shares: u64,
    /// Sum of the limits of active policies. Capital below this line cannot be
    /// withdrawn (FR-020).
    pub locked_limit: u64,
    /// Withdrawals are blocked while this is non-zero (FR-019). Changed only through
    /// `open_incident` and `close_incident`, which keep the block's run below.
    pub open_incidents: u32,
    /// Stored rather than recomputed: the pool signs every transfer out of its
    /// vault, and rederiving the bump on each of those costs compute for a value
    /// that never changes.
    pub bump: u8,
    // Added in T082, after everything a pool had before: an older pool is this
    // layout cut short, so `migrate_pool` only has to grow it, and every earlier
    // field keeps its offset for readers that decode either.
    /// When the latest run of blocked time began: the moment `open_incidents` left
    /// zero, unless that was within one `withdraw_delay` of the previous run ending —
    /// then the run carries on. Zero until the first incident.
    pub blocked_since: i64,
    /// When the latest run ended, `open_incidents` back at zero. Zero until the first
    /// incident closes. A request whose window closed inside the run gets a fresh one
    /// from here (`withdraw_lapses_at`).
    pub unblocked_at: i64,
}

/// A pool as written before T082: `Pool` without the run of blocked time.
pub const LEGACY_POOL_LEN: usize = 8 + 61;

impl Pool {
    /// The pool's side of selling cover: the only place a premium becomes capital
    /// (FR-018) and a limit becomes locked (FR-020). Every issuance path calls this in
    /// the same instruction that moves the premium into the vault, instead of
    /// repeating the arithmetic.
    ///
    /// What makes it worth one place is the order. FR-027 is checked against the
    /// capital the pool held **before** this premium arrived: a policy must not be
    /// allowed to back itself. Copied into a second instruction with the two lines
    /// swapped, it would still look right.
    ///
    /// A premium paid into a pool without shares — only reachable through
    /// `service_fund_pool` — becomes capital nobody owns; `deposit` refuses such a
    /// pool (`PoolHasUnsharedCapital`), and T036 removes the way to create one.
    ///
    /// Nothing is written unless everything succeeds.
    pub fn underwrite(&mut self, limit: u64, premium: u64) -> Result<()> {
        // The whole limit is locked, not the payable part, because FR-020 and FR-027
        // are both written in terms of the limit. That over-locks by the retention,
        // which can never be paid out — capital-inefficient but safe. Flagged in
        // docs/PLAN.md as a question for the spec rather than quietly reinterpreted.
        let free = self
            .total_assets
            .checked_sub(self.locked_limit)
            .ok_or(DrainCoverError::MathOverflow)?;
        require!(limit <= free, DrainCoverError::LimitExceedsFreeCapital);

        let locked_limit = self
            .locked_limit
            .checked_add(limit)
            .ok_or(DrainCoverError::MathOverflow)?;
        let total_assets = self
            .total_assets
            .checked_add(premium)
            .ok_or(DrainCoverError::MathOverflow)?;

        self.locked_limit = locked_limit;
        self.total_assets = total_assets;
        Ok(())
    }

    /// Gives back the reservation of a policy that can no longer pay (FR-020). The
    /// amount is the policy's `remaining_limit`: `underwrite` locked the whole limit
    /// and each payout came off both, so what a policy still holds of
    /// `locked_limit` is exactly what it has left. `total_assets` does not move —
    /// the premium was earned when the cover was sold.
    ///
    /// Refused rather than saturated when the lock is smaller than the amount: that
    /// would mean a reservation was released twice, and flooring at zero would hide
    /// it while freeing capital that still backs other policies.
    pub fn release(&mut self, amount: u64) -> Result<()> {
        self.locked_limit = self
            .locked_limit
            .checked_sub(amount)
            .ok_or(DrainCoverError::MathOverflow)?;
        Ok(())
    }

    /// An incident opened against this pool: withdrawals block until it closes
    /// (FR-019).
    ///
    /// The first one of a run records when blocking began — unless the previous run
    /// ended less than `delay` ago. A request whose window closed inside that run was
    /// given a fresh window from its end, and if this incident blocks that one too, the
    /// two runs have to read as one, or the request would lapse mid-block a second
    /// time. The price is that a request whose window closed in the gap, unblocked, is
    /// revived along with them — at most one `delay` after its own window, and only
    /// by an incident.
    pub fn open_incident(&mut self, now: i64, delay: i64) -> Result<()> {
        if self.open_incidents == 0 {
            let grace_ends = self
                .unblocked_at
                .checked_add(delay)
                .ok_or(DrainCoverError::MathOverflow)?;
            if self.unblocked_at == 0 || now >= grace_ends {
                self.blocked_since = now;
            }
        }
        self.open_incidents = self
            .open_incidents
            .checked_add(1)
            .ok_or(DrainCoverError::MathOverflow)?;
        Ok(())
    }

    /// An incident ended, by payout or by expiry. The last one to close ends the run.
    pub fn close_incident(&mut self, now: i64) -> Result<()> {
        self.open_incidents = self
            .open_incidents
            .checked_sub(1)
            .ok_or(DrainCoverError::MathOverflow)?;
        if self.open_incidents == 0 {
            self.unblocked_at = now;
        }
        Ok(())
    }

    /// When a withdrawal request unlocked at `unlock_ts` stops being completable, or
    /// `None` while the pool is blocked and the request was still alive when the
    /// block began — its end is not known until the incident closes.
    ///
    /// The window is one `delay` after unlocking (T033). An incident does not let it
    /// run out underneath (owner's decision 2026-10-23, SPEC → US2, acceptance 4: the
    /// withdrawal is blocked *until* the incident closes): a window that closed inside
    /// a run of blocked time starts over, a full `delay`, from the end of the run. A
    /// window that had closed before the run began stays closed — an incident does
    /// not revive a request that had already gone stale.
    pub fn withdraw_lapses_at(&self, unlock_ts: i64, delay: i64) -> Result<Option<i64>> {
        let lapses_at = unlock_ts
            .checked_add(delay)
            .ok_or(DrainCoverError::MathOverflow)?;
        let blocked_ever = self.open_incidents > 0 || self.unblocked_at > 0;
        if !blocked_ever || self.blocked_since >= lapses_at {
            return Ok(Some(lapses_at));
        }
        if self.open_incidents > 0 {
            return Ok(None);
        }
        if lapses_at <= self.unblocked_at {
            return Ok(Some(
                self.unblocked_at
                    .checked_add(delay)
                    .ok_or(DrainCoverError::MathOverflow)?,
            ));
        }
        Ok(Some(lapses_at))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(total_assets: u64, locked_limit: u64) -> Pool {
        Pool {
            vault: Pubkey::default(),
            total_assets,
            total_shares: total_assets,
            locked_limit,
            open_incidents: 0,
            blocked_since: 0,
            unblocked_at: 0,
            bump: 255,
        }
    }

    const DELAY: i64 = 100;
    /// A request unlocked at 1 000, so its own window closes at 1 100.
    const UNLOCK: i64 = 1_000;

    /// A pool that went through each `(opened, closed)` incident in turn.
    fn blocked(runs: &[(i64, Option<i64>)]) -> Pool {
        let mut p = pool(1_000, 0);
        for &(opened, closed) in runs {
            p.open_incident(opened, DELAY).unwrap();
            if let Some(closed) = closed {
                p.close_incident(closed).unwrap();
            }
        }
        p
    }

    fn lapses(p: &Pool) -> Option<i64> {
        p.withdraw_lapses_at(UNLOCK, DELAY).unwrap()
    }

    #[test]
    fn a_pool_never_blocked_keeps_the_window_as_it_is() {
        assert_eq!(lapses(&pool(1_000, 0)), Some(1_100));
    }

    #[test]
    fn an_incident_that_ends_inside_the_window_does_not_move_it() {
        assert_eq!(lapses(&blocked(&[(1_010, Some(1_020))])), Some(1_100));
    }

    #[test]
    fn a_window_that_closes_inside_the_run_starts_over_from_its_end() {
        assert_eq!(lapses(&blocked(&[(1_050, Some(1_200))])), Some(1_300));
    }

    #[test]
    fn a_run_that_ends_exactly_as_the_window_closes_still_restarts_it() {
        // Blocked up to the last moment the window had, so it never got to be used.
        assert_eq!(lapses(&blocked(&[(1_050, Some(1_100))])), Some(1_200));
    }

    #[test]
    fn while_blocked_a_live_request_has_no_end_yet() {
        assert_eq!(lapses(&blocked(&[(1_050, None)])), None);
    }

    #[test]
    fn an_incident_opened_after_the_window_closed_revives_nothing() {
        // The window's end is exclusive: opened at 1 100, the request is already gone.
        assert_eq!(lapses(&blocked(&[(1_100, None)])), Some(1_100));
        assert_eq!(lapses(&blocked(&[(1_500, Some(1_600))])), Some(1_100));
    }

    #[test]
    fn overlapping_incidents_block_until_the_last_one_closes() {
        let mut p = blocked(&[(1_050, None), (1_060, Some(1_070))]);
        assert_eq!(lapses(&p), None);
        p.close_incident(1_200).unwrap();
        assert_eq!(lapses(&p), Some(1_300));
    }

    #[test]
    fn an_incident_inside_the_fresh_window_carries_the_run_on() {
        // The fresh window runs to 1 300 and a second incident blocks it at 1 250. Read
        // as two runs, the request would lapse mid-block again.
        let p = blocked(&[(1_050, Some(1_200)), (1_250, Some(1_400))]);
        assert_eq!(p.blocked_since, 1_050);
        assert_eq!(lapses(&p), Some(1_500));
    }

    #[test]
    fn an_incident_after_the_fresh_window_starts_a_run_of_its_own() {
        // 1 300 is where the fresh window ended: the request had its chance.
        let p = blocked(&[(1_050, Some(1_200)), (1_300, None)]);
        assert_eq!(p.blocked_since, 1_300);
        assert_eq!(lapses(&p), Some(1_100));
    }

    #[test]
    fn closing_more_incidents_than_were_opened_is_refused() {
        let mut p = pool(1_000, 0);
        assert!(p.close_incident(1_000).is_err());
        assert_eq!((p.open_incidents, p.unblocked_at), (0, 0));
    }

    fn state(p: &Pool) -> (u64, u64) {
        (p.total_assets, p.locked_limit)
    }

    #[test]
    fn locks_the_limit_and_credits_the_premium() {
        let mut p = pool(1_000, 300);
        p.underwrite(500, 20).unwrap();
        assert_eq!(state(&p), (1_020, 800));
    }

    #[test]
    fn a_limit_may_take_exactly_the_free_capital() {
        let mut p = pool(1_000, 300);
        p.underwrite(700, 1).unwrap();
        assert_eq!(state(&p), (1_001, 1_000));
    }

    #[test]
    fn a_policy_cannot_back_itself_with_its_own_premium() {
        // One unit short of free capital, and the premium arriving with the policy
        // would more than cover it. It must not count.
        let mut p = pool(1_000, 300);
        assert!(p.underwrite(701, 1_000).is_err());
        assert_eq!(state(&p), (1_000, 300));
    }

    #[test]
    fn an_empty_pool_sells_no_cover() {
        let mut p = pool(0, 0);
        assert!(p.underwrite(1, 1_000).is_err());
        assert_eq!(state(&p), (0, 0));
    }

    #[test]
    fn overflow_on_either_side_writes_nothing() {
        // Premium overflows `total_assets` after the limit already passed the check:
        // the lock must not be kept on its own.
        let mut p = pool(u64::MAX, 0);
        assert!(p.underwrite(1, 1).is_err());
        assert_eq!(state(&p), (u64::MAX, 0));
    }

    #[test]
    fn a_pool_locked_beyond_its_capital_is_refused_not_wrapped() {
        // Unreachable today (payouts reduce both sides equally), but US2 withdrawals
        // and US3 slashing are paths that could break `total_assets >= locked_limit`.
        let mut p = pool(100, 200);
        assert!(p.underwrite(1, 1).is_err());
        assert_eq!(state(&p), (100, 200));
    }

    #[test]
    fn release_frees_the_lock_and_keeps_the_premium() {
        let mut p = pool(1_000, 0);
        p.underwrite(600, 20).unwrap();
        p.release(600).unwrap();
        assert_eq!(state(&p), (1_020, 0));
    }

    #[test]
    fn release_of_more_than_is_locked_is_refused_not_floored() {
        let mut p = pool(1_000, 300);
        assert!(p.release(301).is_err());
        assert_eq!(state(&p), (1_000, 300));
    }
}
