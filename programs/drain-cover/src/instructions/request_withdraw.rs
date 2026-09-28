use anchor_lang::prelude::*;

use crate::errors::DrainCoverError;
use crate::state::{Config, Pool, UnderwriterPosition, CONFIG_SEED, POSITION_SEED};

/// Starts the withdrawal clock on some of a position's shares (FR-019).
///
/// **Nothing leaves the pool here, and nothing is priced.** The shares stay in
/// `position.shares` and in `pool.total_shares`, so until the withdrawal completes
/// (T033) the capital behind them keeps backing policies, keeps earning premiums
/// (FR-018) and keeps absorbing payouts (FR-015). The price is taken at completion.
/// Fixing it here would let an underwriter who sees a compromise first lock in the
/// pre-loss price and hand the loss to everyone who stayed.
///
/// **An open incident does not block the request, only the completion.** With the
/// price taken at completion, a request made during an incident gains nothing — and
/// refusing it would let anyone stop the clock of every underwriter in a pool for the
/// price of a bond, the same reasoning that leaves `deposit` open during an incident.
/// The check that FR-019 actually needs is in `complete_withdraw`: an incident opened
/// between request and completion must hold the capital, and only that check sees it.
#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    /// Read for one thing only: how long the wait is.
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// The owner of the position, and nobody else: the position's seeds contain
    /// this key, so a request cannot be made on someone else's behalf.
    pub underwriter: Signer<'info>,
    /// Not read. It is here because the position is addressed by it, and typed so
    /// that it is at least a pool of this program.
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [POSITION_SEED, pool.key().as_ref(), underwriter.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, UnderwriterPosition>,
}

/// The shares to hold for withdrawal and when they may leave.
///
/// A request replaces whatever was requested before, clock included. That is the
/// only way to change or withdraw a request, and it can only ever push the exit
/// later, so it needs no separate cancel instruction and gives nobody a shortcut.
pub fn plan_withdraw_request(shares: u64, held: u64, now: i64, delay: i64) -> Result<(u64, i64)> {
    require!(shares > 0, DrainCoverError::AmountMustBePositive);
    require!(shares <= held, DrainCoverError::WithdrawExceedsShares);
    let unlock_ts = now
        .checked_add(delay)
        .ok_or(DrainCoverError::MathOverflow)?;
    Ok((shares, unlock_ts))
}

pub fn handle_request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let position = &mut ctx.accounts.position;

    let (pending, unlock_ts) = plan_withdraw_request(
        shares,
        position.shares,
        now,
        ctx.accounts.config.withdraw_delay,
    )?;

    // Assigned, not added: a second request is a new request (see above).
    position.pending_withdraw = pending;
    position.unlock_ts = unlock_ts;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;
    const WEEK: i64 = 7 * 86_400;

    #[test]
    fn holds_the_shares_until_now_plus_the_delay() {
        assert_eq!(
            plan_withdraw_request(400, 1_000, NOW, WEEK).unwrap(),
            (400, NOW + WEEK)
        );
    }

    #[test]
    fn a_position_may_request_all_of_its_shares() {
        assert_eq!(
            plan_withdraw_request(1_000, 1_000, NOW, WEEK).unwrap(),
            (1_000, NOW + WEEK)
        );
    }

    #[test]
    fn refuses_more_shares_than_the_position_holds() {
        assert!(plan_withdraw_request(1_001, 1_000, NOW, WEEK).is_err());
        // A position that has never held anything, or was emptied by a completed
        // withdrawal, has nothing to request.
        assert!(plan_withdraw_request(1, 0, NOW, WEEK).is_err());
    }

    #[test]
    fn refuses_a_request_for_nothing() {
        // Zero would overwrite a real pending request with an empty one — a cancel
        // by another name, which is not what the instruction is for.
        assert!(plan_withdraw_request(0, 1_000, NOW, WEEK).is_err());
    }

    #[test]
    fn a_clock_past_the_end_of_time_is_refused_not_wrapped() {
        // A wrapped `unlock_ts` would lie in the past and make the wait vanish.
        assert!(plan_withdraw_request(1, 1, i64::MAX, 1).is_err());
    }
}
