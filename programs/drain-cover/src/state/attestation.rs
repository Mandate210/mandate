use anchor_lang::prelude::*;

pub const ATTESTATION_SEED: &[u8] = b"attest";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verdict {
    Unauthorized,
    Authorized,
}

impl Space for Verdict {
    /// Borsh writes the variant index as one byte.
    const INIT_SPACE: usize = 1;
}

/// One attestor's statement about one incident (FR-007).
///
/// "One attestor, one attestation" (FR-009) is enforced by the PDA itself: the
/// address derives from `(incident, attestor)`, so a second attempt fails in the
/// runtime before any of our code runs. Both identities live in the seeds, which
/// is why this account holds neither.
#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub verdict: Verdict,
    pub submitted_at: i64,
}
