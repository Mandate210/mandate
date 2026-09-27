use anchor_lang::prelude::*;

use crate::errors::DrainCoverError;
use crate::state::{Policy, PolicyStatus, Pool, Protocol, POLICY_SEED, POOL_SEED};

#[derive(Accounts)]
#[instruction(policy_seq: u64)]
pub struct ReleaseExpiredPolicy<'info> {
    #[account(has_one = pool)]
    pub protocol: Account<'info, Protocol>,
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    /// Bound to this protocol by its seeds, as in `open_incident`. `Policy` records
    /// neither its protocol nor its pool, so without them an expired policy of one
    /// protocol could be presented with another's pool and release a reservation
    /// that backs live cover there.
    #[account(
        mut,
        seeds = [POLICY_SEED, protocol.key().as_ref(), &policy_seq.to_le_bytes()],
        bump,
    )]
    pub policy: Account<'info, Policy>,
    // No signer, as in `resolve` and `close_expired_incident`: the release is
    // mechanical, and it is what lets underwriters withdraw capital that no longer
    // backs anything (FR-020) — nobody may be in a position to withhold it.
}

/// Whether a policy's reservation may be released.
///
/// **An open incident on the policy does not hold the release back.** `resolve`
/// asks whether the policy is in force at the moment of the decision (FR-016), so
/// from `end_ts` on no path can pay against this policy, whatever its incidents'
/// tallies say — the reservation backs nothing. The incident itself is closed by
/// `close_expired_incident`, which after `end_ts` closes it regardless of quorum, and
/// until then `open_incidents` blocks withdrawals on its own (FR-019). The three
/// instructions write disjoint fields and commute. If FR-016 is ever read as «in
/// force at the time of the event», this stops being safe: the release would then
/// have to wait for the policy's incidents, which nothing counts per policy today.
///
/// `Exhausted` is refused as already released: `resolve` gave back the retention
/// when the payout used up what was payable, and the policy holds nothing of
/// `locked_limit` any more.
pub fn validate_release(status: PolicyStatus, end_ts: i64, now: i64) -> Result<()> {
    require!(
        !matches!(status, PolicyStatus::Expired | PolicyStatus::Exhausted),
        DrainCoverError::PolicyAlreadyReleased
    );
    require!(now >= end_ts, DrainCoverError::PolicyNotExpired);
    Ok(())
}

pub fn handle_release_expired_policy(
    ctx: Context<ReleaseExpiredPolicy>,
    _policy_seq: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let policy = &mut ctx.accounts.policy;

    validate_release(policy.status, policy.end_ts, now)?;

    ctx.accounts.pool.release(policy.remaining_limit)?;
    // The mark is what makes the release happen once. The account stays: it is
    // part of the trail, and its rent has nobody obvious to go back to.
    policy.status = PolicyStatus::Expired;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const END: i64 = 1_000_000;

    #[test]
    fn releases_from_the_end_second_on() {
        // The end is exclusive in `is_in_force`, so the end second is already out of
        // cover and already releasable — the two readings must not leave a gap.
        assert!(validate_release(PolicyStatus::Active, END, END).is_ok());
        assert!(validate_release(PolicyStatus::Active, END, END + 1).is_ok());
    }

    #[test]
    fn refuses_while_the_policy_can_still_pay() {
        assert!(validate_release(PolicyStatus::Active, END, END - 1).is_err());
    }

    #[test]
    fn releases_a_policy_whose_stored_status_never_left_pending() {
        // Nothing flips `Pending` to `Active` on the start date, so a policy can run
        // its whole period and still read `Pending`.
        assert!(validate_release(PolicyStatus::Pending, END, END).is_ok());
    }

    #[test]
    fn refuses_a_second_release() {
        assert!(validate_release(PolicyStatus::Expired, END, END + 1).is_err());
    }

    #[test]
    fn refuses_an_exhausted_policy_resolve_already_released() {
        assert!(validate_release(PolicyStatus::Exhausted, END, END + 1).is_err());
    }
}
