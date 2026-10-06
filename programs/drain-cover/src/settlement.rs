//! Settling an incident: the arithmetic and the transfers, shared by the two
//! instructions that end one.
//!
//! `attest` settles on the vote that completes the quorum — the payout is initiated by
//! the same operation that records the decision (FR-012, T078). `close_expired_incident`
//! ends what the window left without a quorum. Both move money out of the pool's vault
//! under the pool's seeds, and both decide by the same quorum rule, so neither keeps its
//! own copy.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{create_idempotent, Create};
use anchor_spl::token::{transfer, Transfer};

use crate::instructions::initialize::BPS_DENOMINATOR;
use crate::state::POOL_SEED;

/// Attestations classifying the action as unauthorized that this incident needs
/// (FR-010), rounded up.
///
/// Rounded up because rounding down would let a quorum be cleared by less than the
/// share it asks for: at a set of 3 and 6000 bps, 1.8 attestations rounded down is 1,
/// and a single attestor would decide a payout. The denominator is the set size the
/// incident recorded when it opened, never the current one.
pub fn quorum_threshold(set_size: u16, quorum_bps: u16) -> u16 {
    // u32 throughout: the largest product here is 65535 * 10000, which overflows u16
    // long before it overflows u32. The result is at most `set_size`, because
    // `quorum_bps` is capped at 10000 when the config is created.
    let needed = (u32::from(set_size) * u32::from(quorum_bps)).div_ceil(u32::from(BPS_DENOMINATOR));
    needed as u16
}

/// Splits what is owed into what the pool can pay now and what it cannot (FR-013).
///
/// The shortfall is recorded, not carried: the trail has to state what was not paid,
/// and the policy keeps that part of its limit for a later incident rather than the
/// pool taking on a debt it would settle out of some future underwriter's capital.
pub fn settle_payout(owed: u64, available: u64) -> (u64, u64) {
    let payout = owed.min(available);
    (payout, owed - payout)
}

/// Moves `amount` out of a pool's vault, signed by the pool's PDA.
pub fn pay_from_vault<'info>(
    token_program: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    protocol: &Pubkey,
    pool_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let pool_seeds: &[&[u8]] = &[POOL_SEED, protocol.as_ref(), &[pool_bump]];
    transfer(
        CpiContext::new_with_signer(
            token_program.clone(),
            Transfer {
                from: vault.clone(),
                to: to.clone(),
                authority: pool.clone(),
            },
            &[pool_seeds],
        ),
        amount,
    )
}

/// The accounts that create an owner's associated token account when it is missing.
pub struct TokenAccountFor<'a, 'info> {
    pub payer: &'a AccountInfo<'info>,
    pub token_account: &'a AccountInfo<'info>,
    pub owner: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
}

/// Opens `owner`'s associated token account for the settlement asset unless it exists.
///
/// **This is what keeps a decision from being vetoed by a missing account.** A token
/// account is a precondition of a transfer, and a payout made inside the deciding
/// vote would otherwise fail that vote — the quorum unreached, the incident closed at
/// its deadline as unconfirmed and an honest opener's bond forfeited, all because a
/// beneficiary never opened, or closed, an account. Idempotent, and paid by the
/// attestor whose vote decided: two thousandths of a SOL in a case that should not
/// arise, against a payout nobody can hold back.
///
/// The address is the associated one and nothing else (the caller's `address`
/// constraint): nobody chooses where a payout goes.
pub fn ensure_token_account(accounts: TokenAccountFor<'_, '_>) -> Result<()> {
    create_idempotent(CpiContext::new(
        accounts.associated_token_program.clone(),
        Create {
            payer: accounts.payer.clone(),
            associated_token: accounts.token_account.clone(),
            authority: accounts.owner.clone(),
            mint: accounts.mint.clone(),
            system_program: accounts.system_program.clone(),
            token_program: accounts.token_program.clone(),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_the_quorum_up() {
        // 60% of 3 is 1.8 — two attestations, not one.
        assert_eq!(quorum_threshold(3, 6_000), 2);
        assert_eq!(quorum_threshold(5, 6_000), 3);
        assert_eq!(quorum_threshold(4, 6_000), 3);
    }

    #[test]
    fn asks_the_whole_set_at_unanimity_and_at_least_one_otherwise() {
        assert_eq!(quorum_threshold(7, BPS_DENOMINATOR), 7);
        // A single attestor is the floor: the share is above zero, so somebody has
        // to say so.
        assert_eq!(quorum_threshold(100, 1), 1);
    }

    #[test]
    fn never_asks_for_more_than_the_set() {
        assert_eq!(quorum_threshold(u16::MAX, BPS_DENOMINATOR), u16::MAX);
    }

    #[test]
    fn pays_everything_owed_when_the_pool_can() {
        assert_eq!(settle_payout(800, 1_000), (800, 0));
        assert_eq!(settle_payout(800, 800), (800, 0));
    }

    #[test]
    fn records_what_the_pool_cannot_pay() {
        assert_eq!(settle_payout(800, 500), (500, 300));
        assert_eq!(settle_payout(800, 0), (0, 800));
    }
}
