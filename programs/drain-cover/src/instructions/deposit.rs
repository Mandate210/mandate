use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::errors::DrainCoverError;
use crate::state::{Config, Pool, UnderwriterPosition, CONFIG_SEED, POOL_SEED, POSITION_SEED};

/// Capital into a pool, shares out (FR-017).
///
/// There is no admin here and no check on who the underwriter is: FR-017 says
/// capital comes from any address, without verification of identity and without a
/// jurisdiction filter, and the program collects nothing about the depositor beyond
/// the address that already has to sign.
///
/// Depositing into a pool with an open incident is allowed on purpose. Blocking it
/// would let anyone stop a pool from taking capital for the price of a bond, and it
/// harms nobody but the depositor: they buy in at a price that has not yet absorbed
/// a loss the incident may bring. The reverse — leaving with capital while a claim
/// is being decided — is the one FR-019 blocks.
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Read for one thing only: the asset every pool settles in (FR-014).
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub underwriter: Signer<'info>,
    /// CHECK is unnecessary: the pool PDA is derived from this protocol, so a pool
    /// that does not belong to it cannot be passed.
    pub protocol: UncheckedAccount<'info>,
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    /// Created on the first deposit and reused afterwards. `init_if_needed` rather
    /// than a separate "open a position" instruction: a second instruction would be
    /// one more thing for a client to get wrong, and opening a position decides
    /// nothing.
    #[account(
        init_if_needed,
        payer = underwriter,
        space = 8 + UnderwriterPosition::INIT_SPACE,
        seeds = [POSITION_SEED, pool.key().as_ref(), underwriter.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, UnderwriterPosition>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.asset_mint, token::authority = underwriter)]
    pub source: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Shares for `amount` at the pool's current price.
///
/// Rounding is **down**, always, and always in the pool's favour: the remainder
/// stays with the shares already issued. Rounding up would mint value the vault does
/// not hold, and repeated it drains the pool one unit at a time — which is also why
/// the dust case below is a refusal rather than a mint of zero.
///
/// The product of two `u64` is exactly what a `u128` holds, so the intermediate
/// cannot overflow; the result is still checked on the way back down, because a pool
/// that has taken losses mints more shares than the amount deposited.
pub fn shares_for_deposit(amount: u64, total_assets: u64, total_shares: u64) -> Result<u64> {
    require!(amount > 0, DrainCoverError::AmountMustBePositive);

    if total_shares == 0 {
        // A pool with capital but no shares is the `service_fund_pool` state (T014,
        // removed in T036): that capital belongs to nobody. Minting one-for-one here
        // would hand all of it to whoever deposits first, so the first deposit has to
        // land in an empty pool. A pool is funded through this instruction instead —
        // which is the whole point of removing the service path.
        require!(total_assets == 0, DrainCoverError::PoolHasUnsharedCapital);
        return Ok(amount);
    }

    // Shares outstanding against nothing at all. Reachable, not defensive: a payout
    // takes `total_assets` down, and `settle_payout` can take it to exactly zero. A
    // share is then worth nothing, there is no honest rate to deposit at, and minting
    // one-for-one would split the new capital with holders of worthless shares.
    require!(total_assets > 0, DrainCoverError::PoolWipedOut);

    let shares = u128::from(amount)
        .checked_mul(u128::from(total_shares))
        .ok_or(DrainCoverError::MathOverflow)?
        / u128::from(total_assets);
    let shares = u64::try_from(shares).map_err(|_| DrainCoverError::MathOverflow)?;

    // Below one whole share the deposit would be capital given away: the amount joins
    // `total_assets` and nothing represents it.
    require!(shares > 0, DrainCoverError::DepositTooSmall);

    Ok(shares)
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    // Priced before anything moves, against the pool as the last operation left it.
    let shares = shares_for_deposit(amount, pool.total_assets, pool.total_shares)?;

    transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.underwriter.to_account_info(),
            },
        ),
        amount,
    )?;

    pool.total_assets = pool
        .total_assets
        .checked_add(amount)
        .ok_or(DrainCoverError::MathOverflow)?;
    pool.total_shares = pool
        .total_shares
        .checked_add(shares)
        .ok_or(DrainCoverError::MathOverflow)?;

    // Added to, never assigned: `set_inner` on an account that `init_if_needed` found
    // rather than created would erase an existing position — including a withdrawal
    // already requested against it (T032).
    let position = &mut ctx.accounts.position;
    position.shares = position
        .shares
        .checked_add(shares)
        .ok_or(DrainCoverError::MathOverflow)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A million tokens. The settlement asset has six decimals (FR-014), so the
    /// numbers below are tokens rather than base units.
    const MILLION: u64 = 1_000_000_000_000;

    #[test]
    fn the_first_deposit_into_an_empty_pool_mints_one_for_one() {
        assert_eq!(shares_for_deposit(MILLION, 0, 0).unwrap(), MILLION);
        assert_eq!(shares_for_deposit(1, 0, 0).unwrap(), 1);
    }

    #[test]
    fn refuses_a_first_deposit_into_a_pool_holding_capital_nobody_owns() {
        assert!(shares_for_deposit(MILLION, MILLION, 0).is_err());
        // One base unit of unshared capital is enough: the rule is about ownership,
        // not about the amount being material.
        assert!(shares_for_deposit(MILLION, 1, 0).is_err());
    }

    #[test]
    fn prices_a_later_deposit_against_the_pool() {
        // As much again as the pool holds, so the depositor ends up with half of it.
        assert_eq!(
            shares_for_deposit(MILLION, MILLION, MILLION).unwrap(),
            MILLION
        );
        // A tenth of the pool buys a tenth of the shares.
        assert_eq!(
            shares_for_deposit(MILLION / 10, MILLION, MILLION).unwrap(),
            MILLION / 10
        );
    }

    #[test]
    fn a_premium_makes_a_share_cost_more() {
        // The pool earned 10% since those shares were issued (FR-018): the same money
        // now buys fewer shares, and the difference is what the earlier underwriters
        // earned by being in the pool at the time.
        let shares = shares_for_deposit(MILLION, MILLION + MILLION / 10, MILLION).unwrap();
        assert_eq!(shares, 909_090_909_090);
        assert!(shares < MILLION);
    }

    #[test]
    fn a_payout_makes_a_share_cost_less() {
        // Half the capital went to a beneficiary (FR-015). Whoever comes in next takes
        // their half of what is left, not of what there was.
        assert_eq!(
            shares_for_deposit(MILLION, MILLION / 2, MILLION).unwrap(),
            2 * MILLION
        );
    }

    #[test]
    fn rounds_down_and_leaves_the_remainder_in_the_pool() {
        // 2 shares on 3 assets: 7 assets are 4.66 shares, minted as 4.
        assert_eq!(shares_for_deposit(7, 3, 2).unwrap(), 4);
        // 999 shares on 1000 assets: 333 assets are 332.667 shares, minted as 332.
        assert_eq!(shares_for_deposit(333, 1_000, 999).unwrap(), 332);
    }

    #[test]
    fn refuses_dust_that_would_mint_no_shares() {
        // A share costs 2 assets and the deposit is 1.
        assert!(shares_for_deposit(1, 2, 1).is_err());
        // The same shape after the pool has grown enormously per share.
        assert!(shares_for_deposit(1, MILLION, 1).is_err());
    }

    #[test]
    fn refuses_a_zero_amount() {
        assert!(shares_for_deposit(0, 0, 0).is_err());
        assert!(shares_for_deposit(0, MILLION, MILLION).is_err());
    }

    #[test]
    fn refuses_a_pool_whose_capital_a_payout_took_to_zero() {
        assert!(shares_for_deposit(MILLION, 0, MILLION).is_err());
    }

    #[test]
    fn the_largest_pool_the_types_allow_does_not_overflow() {
        // The intermediate here is u64::MAX squared, which is exactly what a u128
        // holds — one bit more anywhere and this would be a wrap, not an error.
        assert_eq!(
            shares_for_deposit(u64::MAX, u64::MAX, u64::MAX).unwrap(),
            u64::MAX
        );
        // Shares worth a fraction of a unit each: the count no longer fits in u64 and
        // is refused instead of truncated.
        assert!(shares_for_deposit(u64::MAX, 1, u64::MAX).is_err());
    }

    /// Nobody may leave with more than they brought by depositing alone — valued at
    /// the instant after the deposit, which is the only claim a deposit creates.
    /// SC-010 measures the same property across 50 operations (T034); this is the
    /// single-step floor under it.
    #[test]
    fn a_deposit_never_buys_more_than_it_paid_for() {
        let cases: [(u64, u64, u64); 6] = [
            (MILLION, 0, 0),
            (MILLION, MILLION, MILLION),
            (7, 3, 2),
            (MILLION, MILLION + MILLION / 10, MILLION),
            (MILLION, MILLION / 2, MILLION),
            (333, 1_000, 999),
        ];

        for (amount, total_assets, total_shares) in cases {
            let minted = shares_for_deposit(amount, total_assets, total_shares).unwrap();
            let assets_after = u128::from(total_assets) + u128::from(amount);
            let shares_after = u128::from(total_shares) + u128::from(minted);
            let worth = u128::from(minted) * assets_after / shares_after;
            assert!(
                worth <= u128::from(amount),
                "{minted} shares of {shares_after} are worth {worth}, paid {amount}"
            );
        }
    }
}
