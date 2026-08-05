use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::errors::DrainCoverError;
use crate::state::{Config, Pool, CONFIG_SEED, POOL_SEED};

/// Puts capital in a pool without issuing shares.
///
/// **Temporary, and removed in T036.** US1 has to demonstrate a payout, which needs a
/// funded pool; the real `deposit` brings shares, the premium accumulator and SC-010
/// with it, and none of that belongs in the smallest thing that proves the product.
///
/// Capital funded this way is owned by nobody: there is no `UnderwriterPosition`, so
/// it cannot be withdrawn. That is intentional for a service operation on a test
/// deployment and is exactly why the instruction cannot survive into US2.
#[derive(Accounts)]
pub struct ServiceFundPool<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    /// CHECK is unnecessary: the pool PDA is derived from this protocol, so a pool
    /// that does not belong to it cannot be passed.
    pub protocol: UncheckedAccount<'info>,
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.asset_mint, token::authority = admin)]
    pub source: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_service_fund_pool(ctx: Context<ServiceFundPool>, amount: u64) -> Result<()> {
    require!(amount > 0, DrainCoverError::AmountMustBePositive);

    transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.admin.to_account_info(),
            },
        ),
        amount,
    )?;

    // Recorded, not inferred from the vault balance: the program's own accounting is
    // the source of truth, and a stray transfer into the vault must not silently
    // become backing for a policy.
    let pool = &mut ctx.accounts.pool;
    pool.total_assets = pool
        .total_assets
        .checked_add(amount)
        .ok_or(DrainCoverError::MathOverflow)?;

    Ok(())
}
