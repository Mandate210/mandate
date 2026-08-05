use anchor_lang::prelude::*;

use crate::errors::DrainCoverError;
use crate::state::{DeclarationEntry, Protocol, DECLARATION_SEED};

#[derive(Accounts)]
#[instruction(seq: u64)]
pub struct RevokeDeclaration<'info> {
    #[account(has_one = authority)]
    pub protocol: Account<'info, Protocol>,
    pub authority: Signer<'info>,
    /// The entry carries no protocol field, so the seeds are what tie it to this
    /// protocol — without them one protocol's authority could revoke another's
    /// declaration, and revocation is the one operation nobody has to wait for.
    #[account(
        mut,
        seeds = [DECLARATION_SEED, protocol.key().as_ref(), &seq.to_le_bytes()],
        bump,
    )]
    pub entry: Account<'info, DeclarationEntry>,
    // No `Config` here on purpose: FR-032 gives revocation and narrowing no delay,
    // so nothing in this instruction reads a protocol-wide parameter.
}

/// A revised window has to permit strictly less than the one it replaces, and only
/// from now on.
///
/// **Only forward.** Revocation is immediate but not retroactive: an operation
/// performed while the entry was effective stays declared, and every attestor
/// evaluates a transaction against the entry as it stood at that transaction's
/// timestamp. A window pulled back into the past would undo that — legitimate
/// operations already executed inside the window would become undeclared, which is
/// an incident and a payout against a protocol that did nothing wrong.
///
/// **Only narrower.** Widening is what `declaration_delay` exists to slow down
/// (FR-031), so it goes through a new entry and waits like any other. Anything a
/// compromised authority can do here only shrinks its own permissions.
///
/// Narrowing a window to nothing is a revocation, and revocation is the argument
/// for it — hence the refusal of a window that would end before it begins.
pub fn validate_narrowing(
    not_before: i64,
    not_after: Option<i64>,
    narrow_to: i64,
    now: i64,
) -> Result<()> {
    require!(
        narrow_to >= now,
        DrainCoverError::NarrowedWindowEndsInThePast
    );
    require!(
        narrow_to > not_before,
        DrainCoverError::InvalidDeclarationWindow
    );
    // `None` is a permanent entry, so any bounded end at all is narrower than it.
    if let Some(current) = not_after {
        require!(
            narrow_to < current,
            DrainCoverError::DeclarationWindowNotNarrower
        );
    }

    Ok(())
}

/// `narrow_to: None` revokes the entry outright; `Some(ts)` shortens its window to
/// end at `ts`. Both take effect at once (FR-032).
pub fn handle_revoke_declaration(
    ctx: Context<RevokeDeclaration>,
    _seq: u64,
    narrow_to: Option<i64>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let entry = &mut ctx.accounts.entry;

    // A revoked entry is final: narrowing one further, or revoking it twice, means
    // the caller is working from a stale view of the chain.
    require!(
        entry.revoked_at.is_none(),
        DrainCoverError::DeclarationRevoked
    );

    match narrow_to {
        // Recorded rather than erased: the entry is the public record of what the
        // protocol had declared, and an incident opened later is judged against the
        // declaration as it stood at the time (FR-030).
        None => entry.revoked_at = Some(now),
        Some(narrow_to) => {
            validate_narrowing(entry.not_before, entry.not_after, narrow_to, now)?;
            entry.not_after = Some(narrow_to);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;
    const NOT_BEFORE: i64 = NOW - 3_600;
    const NOT_AFTER: i64 = NOW + 3_600;

    #[test]
    fn accepts_an_earlier_end_from_now_on() {
        assert!(validate_narrowing(NOT_BEFORE, Some(NOT_AFTER), NOW + 600, NOW).is_ok());
        // Ending the window at this very moment is the smallest legal narrowing.
        assert!(validate_narrowing(NOT_BEFORE, Some(NOT_AFTER), NOW, NOW).is_ok());
    }

    #[test]
    fn accepts_bounding_a_permanent_entry() {
        assert!(validate_narrowing(NOT_BEFORE, None, NOW + 600, NOW).is_ok());
    }

    #[test]
    fn rejects_an_end_in_the_past() {
        // The window is still open, and this would retroactively un-declare whatever
        // ran inside it since NOW - 1.
        assert!(validate_narrowing(NOT_BEFORE, Some(NOT_AFTER), NOW - 1, NOW).is_err());
    }

    #[test]
    fn rejects_widening() {
        assert!(validate_narrowing(NOT_BEFORE, Some(NOT_AFTER), NOT_AFTER + 1, NOW).is_err());
        assert!(validate_narrowing(NOT_BEFORE, Some(NOT_AFTER), NOT_AFTER, NOW).is_err());
    }

    #[test]
    fn rejects_narrowing_a_window_out_of_existence() {
        let not_before = NOW + 7 * 86_400;
        let not_after = not_before + 3_600;
        assert!(validate_narrowing(not_before, Some(not_after), not_before, NOW).is_err());
        assert!(validate_narrowing(not_before, Some(not_after), NOW, NOW).is_err());
    }
}
