use anchor_lang::prelude::*;

pub const POLICY_SEED: &[u8] = b"policy";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PolicyStatus {
    /// Issued, premium not paid in full. An incident in this state is recorded
    /// but pays nothing (FR-005, FR-016).
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
