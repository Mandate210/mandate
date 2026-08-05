use anchor_lang::prelude::*;

use crate::errors::DrainCoverError;
use crate::state::{Config, DeclarationEntry, Protocol, CONFIG_SEED, DECLARATION_SEED};

#[derive(Accounts)]
pub struct SubmitDeclaration<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// A declaration is the protocol's statement about its own operations, so the
    /// admin has no part in it — unlike registration or issuance, which are service
    /// operations in P1. `has_one` is the whole authorisation check.
    #[account(mut, has_one = authority)]
    pub protocol: Account<'info, Protocol>,
    /// Pays for the entry as well as signing it: the protocol carries the cost of
    /// its own declaration, and one signer is one fewer way for a caller to get the
    /// accounts wrong.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + DeclarationEntry::INIT_SPACE,
        seeds = [
            DECLARATION_SEED,
            protocol.key().as_ref(),
            &protocol.next_declaration_seq.to_le_bytes(),
        ],
        bump,
    )]
    pub entry: Account<'info, DeclarationEntry>,
    pub system_program: Program<'info, System>,
}

/// Windows that could never permit anything are refused rather than stored.
///
/// The permanent window is the one that matters (FR-035): `not_after: None` is
/// effective forever, and a compromised privileged key inherits it in full, so it is
/// only allowed for operations that move no funds. The check lives on-chain because
/// such an entry should not exist at all, rather than be discarded by each attestor
/// separately (docs/PLAN.md → «Тип вікна запису декларації»).
///
/// A window that closes at or before `effective_at` is dead on arrival: FR-031 makes
/// the entry effective only after the delay, so nothing it covers could ever run
/// inside it. Storing it would be worse than refusing — the protocol would believe a
/// maintenance window is declared while every attestor sees an undeclared operation.
pub fn validate_window(
    not_before: i64,
    not_after: Option<i64>,
    moves_funds: bool,
    effective_at: i64,
) -> Result<()> {
    let Some(not_after) = not_after else {
        require!(!moves_funds, DrainCoverError::PermanentWindowNotAllowed);
        return Ok(());
    };

    require!(
        not_after > not_before,
        DrainCoverError::InvalidDeclarationWindow
    );
    require!(
        not_after > effective_at,
        DrainCoverError::DeclarationExpiresBeforeEffective
    );

    Ok(())
}

pub fn handle_submit_declaration(
    ctx: Context<SubmitDeclaration>,
    declared_program: Pubkey,
    ix_discriminator: [u8; 8],
    not_before: i64,
    not_after: Option<i64>,
    moves_funds: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // FR-031. The delay is what a compromised authority cannot skip: it may submit
    // whatever entry it likes, but the entry only starts covering anything after the
    // team has had `declaration_delay` to notice it and revoke it (FR-032).
    let effective_at = now
        .checked_add(ctx.accounts.config.declaration_delay)
        .ok_or(DrainCoverError::MathOverflow)?;

    validate_window(not_before, not_after, moves_funds, effective_at)?;

    ctx.accounts.entry.set_inner(DeclarationEntry {
        program_id: declared_program,
        ix_discriminator,
        not_before,
        not_after,
        moves_funds,
        submitted_at: now,
        effective_at,
        revoked_at: None,
    });

    let protocol = &mut ctx.accounts.protocol;
    protocol.next_declaration_seq = protocol
        .next_declaration_seq
        .checked_add(1)
        .ok_or(DrainCoverError::MathOverflow)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000;
    const EFFECTIVE_AT: i64 = NOW + 86_400;

    #[test]
    fn accepts_a_bounded_window_that_outlives_the_delay() {
        assert!(validate_window(NOW, Some(EFFECTIVE_AT + 3_600), true, EFFECTIVE_AT).is_ok());
        assert!(validate_window(NOW, Some(EFFECTIVE_AT + 3_600), false, EFFECTIVE_AT).is_ok());
        // A window opening after the entry takes effect is the ordinary case: the
        // protocol plans maintenance further out than the delay requires.
        assert!(validate_window(
            EFFECTIVE_AT + 3_600,
            Some(EFFECTIVE_AT + 7_200),
            true,
            EFFECTIVE_AT
        )
        .is_ok());
    }

    #[test]
    fn accepts_a_permanent_window_only_without_fund_movement() {
        // Pausing a protocol is the case FR-035 exists to allow: it cannot be
        // planned ahead, and it moves nothing.
        assert!(validate_window(NOW, None, false, EFFECTIVE_AT).is_ok());
        assert!(validate_window(NOW, None, true, EFFECTIVE_AT).is_err());
    }

    #[test]
    fn rejects_an_inverted_or_empty_window() {
        assert!(validate_window(
            EFFECTIVE_AT + 7_200,
            Some(EFFECTIVE_AT + 3_600),
            false,
            EFFECTIVE_AT
        )
        .is_err());
        assert!(validate_window(
            EFFECTIVE_AT + 3_600,
            Some(EFFECTIVE_AT + 3_600),
            false,
            EFFECTIVE_AT
        )
        .is_err());
    }

    #[test]
    fn rejects_a_window_that_closes_before_the_entry_is_effective() {
        assert!(validate_window(NOW, Some(EFFECTIVE_AT - 1), false, EFFECTIVE_AT).is_err());
        // Exactly at the boundary the entry is effective for zero seconds, which is
        // the same nothing.
        assert!(validate_window(NOW, Some(EFFECTIVE_AT), false, EFFECTIVE_AT).is_err());
    }
}
