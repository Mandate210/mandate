use anchor_lang::prelude::*;

pub const POLICY_SEED: &[u8] = b"policy";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PolicyStatus {
    /// Issued and paid for, but its period has not started yet.
    Pending,
    Active,
    /// Past its end date.
    Expired,
    /// Limit fully paid out (FR-015).
    Exhausted,
}

impl Space for PolicyStatus {
    /// Borsh writes the variant index as one byte.
    const INIT_SPACE: usize = 1;
}

/// A cover agreement between one covered protocol and its pool (FR-003).
#[account]
#[derive(InitSpace)]
pub struct Policy {
    /// Cover limit. The payout is derived from this and `retention`, never from
    /// the amount actually drained (FR-013).
    pub limit: u64,
    /// Part of the limit that is never paid, under any circumstance. It makes a
    /// self-staged incident lose money arithmetically, without anyone having to
    /// judge intent (FR-033).
    pub retention: u64,
    /// What is left of the limit after previous payouts (FR-015).
    pub remaining_limit: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub premium_paid: u64,
    /// Fixed at issuance and immovable while an incident is open (FR-004).
    pub beneficiary: Pubkey,
    pub status: PolicyStatus,
}

impl Policy {
    /// Whether the policy covers an event at `now`.
    ///
    /// **The period is the truth, not `status`.** No instruction wakes up to flip
    /// `Pending` into `Active` when a start date arrives, and none marks a policy
    /// `Expired` on its end date — a stored status can only be as fresh as the last
    /// transaction that touched the account. FR-016 hangs a payout on whether the
    /// policy was active at the moment of decision, so that question is answered from
    /// the timestamps every time it is asked.
    pub fn is_in_force(&self, now: i64) -> bool {
        self.status != PolicyStatus::Exhausted
            && self.premium_paid > 0
            && now >= self.start_ts
            && now < self.end_ts
    }

    /// What a payout on this policy would be: the remaining limit less the retention
    /// that is never paid under any circumstance (FR-013, FR-033).
    pub fn payable(&self) -> u64 {
        self.remaining_limit.saturating_sub(self.retention)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(start_ts: i64, end_ts: i64) -> Policy {
        Policy {
            limit: 1_000,
            retention: 200,
            remaining_limit: 1_000,
            start_ts,
            end_ts,
            premium_paid: 10,
            beneficiary: Pubkey::new_unique(),
            status: PolicyStatus::Active,
        }
    }

    #[test]
    fn is_in_force_inside_its_period() {
        assert!(policy(100, 200).is_in_force(100));
        assert!(policy(100, 200).is_in_force(199));
    }

    #[test]
    fn is_not_in_force_outside_its_period() {
        assert!(!policy(100, 200).is_in_force(99));
        // The end is exclusive: an event at the expiry second is not covered.
        assert!(!policy(100, 200).is_in_force(200));
    }

    #[test]
    fn is_not_in_force_without_a_premium() {
        let mut unpaid = policy(100, 200);
        unpaid.premium_paid = 0;
        assert!(!unpaid.is_in_force(150));
    }

    #[test]
    fn is_not_in_force_once_exhausted() {
        let mut spent = policy(100, 200);
        spent.status = PolicyStatus::Exhausted;
        assert!(!spent.is_in_force(150));
    }

    #[test]
    fn payable_is_the_remaining_limit_less_the_retention() {
        assert_eq!(policy(100, 200).payable(), 800);
    }

    #[test]
    fn payable_is_zero_when_the_retention_swallows_what_is_left() {
        let mut nearly_spent = policy(100, 200);
        nearly_spent.remaining_limit = 150;
        // Saturating rather than wrapping: after a partial payout the remaining limit
        // can fall below the retention, and a wrap would turn nothing owed into
        // everything owed.
        assert_eq!(nearly_spent.payable(), 0);
    }
}
