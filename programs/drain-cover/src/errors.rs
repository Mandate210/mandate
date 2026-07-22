use anchor_lang::prelude::*;

#[error_code]
pub enum DrainCoverError {
    #[msg("Declaration entry is not yet effective")]
    DeclarationNotEffective,
    #[msg("Attestor is not in the active set for this incident")]
    AttestorNotActive,
    #[msg("Attestation window for this incident has closed")]
    AttestationWindowClosed,
    #[msg("Policy is not active")]
    PolicyNotActive,
    #[msg("Pool capital is locked by active policies")]
    CapitalLocked,
    #[msg("Withdrawal is blocked while the pool has an open incident")]
    WithdrawalBlockedByIncident,
}
