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
    /// Withdrawals are blocked while this is non-zero (FR-019).
    pub open_incidents: u32,
    /// Stored rather than recomputed: the pool signs every transfer out of its
    /// vault, and rederiving the bump on each of those costs compute for a value
    /// that never changes.
    pub bump: u8,
}

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
            bump: 255,
        }
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
}
