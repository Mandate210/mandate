use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::errors::DrainCoverError;
use crate::settlement::pay_from_vault;
use crate::state::{Config, Pool, UnderwriterPosition, CONFIG_SEED, POOL_SEED, POSITION_SEED};

/// Pays out shares a position requested earlier (FR-019, FR-020, SC-009).
///
/// **Priced here, not at the request.** The shares stayed in the pool through the
/// wait, earning premiums and bearing payouts, and they leave at what a share is
/// worth now (see `request_withdraw.rs` for why).
///
/// **Blocked while the pool has an open incident** (FR-019). This is the check the
/// request deliberately leaves out: only here is an incident opened between request
/// and completion visible.
///
/// **Partial when capital is locked** (FR-020, owner's decision 2026-10-20). What the
/// free capital — `total_assets − locked_limit` — can buy is paid; the rest stays
/// requested under the same clock and can be completed as policies expire, without a
/// second wait. Refusing outright would send the underwriter back to request again,
/// and a new request restarts the wait: SC-009 asks for at most two operations.
///
/// **Valid for one `withdraw_delay` after it unlocks** (owner's decision 2026-10-20).
/// A request that stayed completable forever would be a standing option to leave the
/// moment a compromise is visible, ahead of the incident about it — the gap the wait
/// is there to cover. No new `Config` field: the window reuses the delay, so the
/// layout and every deployed `Config` stay as they are.
#[derive(Accounts)]
pub struct CompleteWithdraw<'info> {
    /// Read for the wait, which also sizes the window, and for the asset (FR-014).
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// The owner of the position: its seeds contain this key.
    pub underwriter: Signer<'info>,
    /// CHECK is unnecessary: the pool PDA is derived from this protocol, and the
    /// pool signs the transfer out of its vault with the same seeds.
    pub protocol: UncheckedAccount<'info>,
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [POSITION_SEED, pool.key().as_ref(), underwriter.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, UnderwriterPosition>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    /// Any account of the settlement asset: the owner signs, so where the money goes
    /// is theirs to say.
    #[account(mut, token::mint = config.asset_mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// What a completion burns and what it pays.
#[derive(Debug, PartialEq, Eq)]
pub struct WithdrawCompletion {
    pub shares: u64,
    pub amount: u64,
}

/// `shares × assets / total` rounded down, in `u128` so the product cannot overflow.
fn pro_rata(shares: u64, assets: u64, total: u64) -> Result<u64> {
    let value = u128::from(shares)
        .checked_mul(u128::from(assets))
        .ok_or(DrainCoverError::MathOverflow)?
        .checked_div(u128::from(total))
        .ok_or(DrainCoverError::MathOverflow)?;
    u64::try_from(value).map_err(|_| DrainCoverError::MathOverflow.into())
}

/// The shares a completion burns and the amount it pays, or why it cannot happen now.
///
/// Both roundings are **down**, in the pool's favour, as in `deposit`: a share that
/// leaves never takes more than it is worth, so those who stay are never diluted.
/// When free capital caps the payout, the shares it buys are counted down first and
/// then priced down again — the second rounding is what keeps the amount within the
/// free capital.
pub fn plan_withdraw_completion(
    position: &UnderwriterPosition,
    pool: &Pool,
    now: i64,
    delay: i64,
) -> Result<WithdrawCompletion> {
    let pending = position.pending_withdraw;
    require!(pending > 0, DrainCoverError::NoWithdrawRequested);

    require!(
        now >= position.unlock_ts,
        DrainCoverError::WithdrawNotUnlocked
    );
    let lapses_at = position
        .unlock_ts
        .checked_add(delay)
        .ok_or(DrainCoverError::MathOverflow)?;
    require!(now < lapses_at, DrainCoverError::WithdrawRequestExpired);

    require!(
        pool.open_incidents == 0,
        DrainCoverError::WithdrawalBlockedByIncident
    );

    // Shares outstanding against nothing: no price to pay them at (as in `deposit`).
    require!(pool.total_assets > 0, DrainCoverError::PoolWipedOut);

    // Refused rather than floored at zero: a pool locked beyond its capital means
    // the books are already wrong, and flooring would hide it.
    let free = pool
        .total_assets
        .checked_sub(pool.locked_limit)
        .ok_or(DrainCoverError::MathOverflow)?;

    let worth = pro_rata(pending, pool.total_assets, pool.total_shares)?;
    if worth <= free {
        require!(worth > 0, DrainCoverError::WithdrawTooSmall);
        return Ok(WithdrawCompletion {
            shares: pending,
            amount: worth,
        });
    }

    // FR-020: only what the free capital buys. Fewer than `pending`, because the
    // whole request is worth more than `free`.
    let shares = pro_rata(free, pool.total_shares, pool.total_assets)?;
    let amount = pro_rata(shares, pool.total_assets, pool.total_shares)?;
    require!(amount > 0, DrainCoverError::CapitalLocked);
    Ok(WithdrawCompletion { shares, amount })
}

pub fn handle_complete_withdraw(ctx: Context<CompleteWithdraw>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let plan = plan_withdraw_completion(
        &ctx.accounts.position,
        &ctx.accounts.pool,
        now,
        ctx.accounts.config.withdraw_delay,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.total_assets = pool
        .total_assets
        .checked_sub(plan.amount)
        .ok_or(DrainCoverError::MathOverflow)?;
    pool.total_shares = pool
        .total_shares
        .checked_sub(plan.shares)
        .ok_or(DrainCoverError::MathOverflow)?;

    // What was not paid stays requested, under the same clock (see above).
    let position = &mut ctx.accounts.position;
    position.shares = position
        .shares
        .checked_sub(plan.shares)
        .ok_or(DrainCoverError::MathOverflow)?;
    position.pending_withdraw = position
        .pending_withdraw
        .checked_sub(plan.shares)
        .ok_or(DrainCoverError::MathOverflow)?;

    pay_from_vault(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.destination.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.protocol.key(),
        ctx.accounts.pool.bump,
        plan.amount,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNLOCK: i64 = 1_000_000;
    const WEEK: i64 = 7 * 86_400;

    fn position(shares: u64, pending: u64) -> UnderwriterPosition {
        UnderwriterPosition {
            shares,
            pending_withdraw: pending,
            unlock_ts: UNLOCK,
        }
    }

    fn pool(total_assets: u64, total_shares: u64, locked_limit: u64) -> Pool {
        Pool {
            vault: Pubkey::default(),
            total_assets,
            total_shares,
            locked_limit,
            open_incidents: 0,
            bump: 255,
        }
    }

    fn done(shares: u64, amount: u64) -> WithdrawCompletion {
        WithdrawCompletion { shares, amount }
    }

    /// `require!` stamps the source line into the error, so errors are compared by
    /// code — the thing a client actually sees.
    fn refused(result: Result<WithdrawCompletion>) -> u32 {
        match result {
            Err(Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    fn code(e: DrainCoverError) -> u32 {
        u32::from(e)
    }

    fn plan(p: &UnderwriterPosition, pool: &Pool) -> Result<WithdrawCompletion> {
        plan_withdraw_completion(p, pool, UNLOCK, WEEK)
    }

    #[test]
    fn pays_the_requested_shares_at_the_price_now() {
        // The pool earned 10% while the shares waited (FR-018), and they leave with it.
        assert_eq!(
            plan(&position(1_000, 400), &pool(1_100, 1_000, 0)).unwrap(),
            done(400, 440)
        );
    }

    #[test]
    fn a_loss_during_the_wait_is_carried_out_by_the_leaver() {
        // Half the capital went to a beneficiary after the request. Priced at the
        // request, the leaver would hand their share of it to those who stayed.
        assert_eq!(
            plan(&position(1_000, 400), &pool(500, 1_000, 0)).unwrap(),
            done(400, 200)
        );
    }

    #[test]
    fn rounds_down_and_leaves_the_remainder_in_the_pool() {
        // 1 share of 3 on 10 assets is 3.33, paid as 3.
        assert_eq!(plan(&position(1, 1), &pool(10, 3, 0)).unwrap(), done(1, 3));
    }

    #[test]
    fn waits_until_the_unlock_second_itself() {
        let p = position(1_000, 400);
        let pl = pool(1_000, 1_000, 0);
        assert_eq!(
            refused(plan_withdraw_completion(&p, &pl, UNLOCK - 1, WEEK)),
            code(DrainCoverError::WithdrawNotUnlocked)
        );
        assert!(plan_withdraw_completion(&p, &pl, UNLOCK, WEEK).is_ok());
    }

    #[test]
    fn a_request_lapses_one_wait_after_it_unlocks() {
        let p = position(1_000, 400);
        let pl = pool(1_000, 1_000, 0);
        assert!(plan_withdraw_completion(&p, &pl, UNLOCK + WEEK - 1, WEEK).is_ok());
        // The end is exclusive, like a policy's `end_ts`.
        assert_eq!(
            refused(plan_withdraw_completion(&p, &pl, UNLOCK + WEEK, WEEK)),
            code(DrainCoverError::WithdrawRequestExpired)
        );
    }

    #[test]
    fn nothing_to_complete_without_a_request() {
        assert_eq!(
            refused(plan(&position(1_000, 0), &pool(1_000, 1_000, 0))),
            code(DrainCoverError::NoWithdrawRequested)
        );
    }

    #[test]
    fn an_open_incident_holds_the_capital() {
        let mut pl = pool(1_000, 1_000, 0);
        pl.open_incidents = 1;
        assert_eq!(
            refused(plan(&position(1_000, 400), &pl)),
            code(DrainCoverError::WithdrawalBlockedByIncident)
        );
    }

    #[test]
    fn pays_in_full_when_the_free_capital_is_exactly_enough() {
        assert_eq!(
            plan(&position(1_000, 400), &pool(1_000, 1_000, 600)).unwrap(),
            done(400, 400)
        );
        // At a fractional price the boundary matters: 1 share of 3 on 10 assets is
        // worth 3, exactly what is free. Sent down the capped path it would buy 0.9
        // of a share — none — and be refused for capital that is in fact there.
        assert_eq!(plan(&position(1, 1), &pool(10, 3, 7)).unwrap(), done(1, 3));
    }

    #[test]
    fn pays_what_the_free_capital_allows_and_keeps_the_rest_requested() {
        // 500 requested, 300 free: 300 leave now, 200 stay in the queue (FR-020).
        assert_eq!(
            plan(&position(1_000, 500), &pool(1_000, 1_000, 700)).unwrap(),
            done(300, 300)
        );
    }

    #[test]
    fn a_partial_payout_rounds_both_ways_in_the_pool_s_favour() {
        // 400 free at 1.1 a share: 363.6 shares, burned as 363, paid as 399.3 → 399.
        let got = plan(&position(1_000, 500), &pool(1_100, 1_000, 700)).unwrap();
        assert_eq!(got, done(363, 399));
        assert!(got.amount <= 400);
    }

    #[test]
    fn refuses_when_every_unit_is_locked() {
        assert_eq!(
            refused(plan(&position(1_000, 400), &pool(1_000, 1_000, 1_000))),
            code(DrainCoverError::CapitalLocked)
        );
    }

    #[test]
    fn refuses_when_the_free_capital_buys_less_than_one_share() {
        // A share is worth 100 and only 50 is free: nothing whole can leave.
        assert_eq!(
            refused(plan(&position(10, 5), &pool(1_000, 10, 950))),
            code(DrainCoverError::CapitalLocked)
        );
    }

    #[test]
    fn refuses_shares_worth_less_than_one_unit() {
        // 1 asset behind 1 000 shares: a single share is worth a thousandth.
        assert_eq!(
            refused(plan(&position(1, 1), &pool(1, 1_000, 0))),
            code(DrainCoverError::WithdrawTooSmall)
        );
    }

    #[test]
    fn refuses_a_pool_whose_capital_a_payout_took_to_zero() {
        assert_eq!(
            refused(plan(&position(1_000, 400), &pool(0, 1_000, 0))),
            code(DrainCoverError::PoolWipedOut)
        );
    }

    #[test]
    fn a_pool_locked_beyond_its_capital_is_refused_not_wrapped() {
        // Unreachable while `total_assets >= locked_limit` holds; if a later path
        // breaks it, the free capital must not wrap into a fortune.
        assert_eq!(
            refused(plan(&position(1_000, 400), &pool(100, 1_000, 200))),
            code(DrainCoverError::MathOverflow)
        );
    }

    #[test]
    fn a_window_past_the_end_of_time_is_refused_not_wrapped() {
        let mut p = position(1_000, 400);
        p.unlock_ts = i64::MAX;
        assert_eq!(
            refused(plan_withdraw_completion(
                &p,
                &pool(1_000, 1_000, 0),
                i64::MAX,
                1
            )),
            code(DrainCoverError::MathOverflow)
        );
    }

    #[test]
    fn the_largest_pool_the_types_allow_does_not_overflow() {
        assert_eq!(
            plan(&position(u64::MAX, u64::MAX), &pool(u64::MAX, u64::MAX, 0)).unwrap(),
            done(u64::MAX, u64::MAX)
        );
    }

    /// Whoever stays is never worse off per share for someone else leaving, and the
    /// leaver never takes free capital that is not there. SC-010 measures the same
    /// across 50 operations (T034); this is the single-step floor under it.
    #[test]
    fn leaving_never_costs_those_who_stay() {
        let cases: [(u64, u64, u64, u64); 8] = [
            (400, 1_100, 1_000, 0),
            (400, 500, 1_000, 0),
            (1, 10, 3, 0),
            (500, 1_000, 1_000, 700),
            (500, 1_100, 1_000, 700),
            (333, 1_000, 999, 1),
            (7, 13, 9, 4),
            (999, 1_000, 999, 0),
        ];

        for (pending, assets, shares, locked) in cases {
            let got = plan(&position(shares, pending), &pool(assets, shares, locked)).unwrap();
            assert!(got.shares <= pending);
            assert!(
                got.amount <= assets - locked,
                "{got:?} takes locked capital"
            );
            // (assets − amount) / (shares − burned) ≥ assets / shares, cross-multiplied.
            let before = u128::from(assets) * u128::from(shares - got.shares);
            let after = u128::from(assets - got.amount) * u128::from(shares);
            assert!(after >= before, "{got:?} dilutes the shares left behind");
        }
    }
}
