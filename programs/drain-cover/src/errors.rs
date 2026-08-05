use anchor_lang::prelude::*;

/// Error codes are `6000 + index`, so a client that maps a number to a meaning
/// breaks if this list is reordered. **Append only** — never insert.
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
    /// FR-035. Kept as its own code rather than folded into a generic validation
    /// error: a rejected permanent window is a deliberate refusal to let a
    /// fund-moving operation escape the declaration delay, and the caller should
    /// be able to tell that apart from a malformed request.
    #[msg("A permanent declaration entry is only allowed for operations that move no funds")]
    PermanentWindowNotAllowed,
    #[msg("Declaration window ends before it begins")]
    InvalidDeclarationWindow,
    #[msg("Declaration entry has been revoked")]
    DeclarationRevoked,
    #[msg("Privileged address list is full")]
    TooManyPrivilegedAddresses,
    #[msg("Incident is not open")]
    IncidentNotOpen,
    #[msg("Quorum has not been reached")]
    QuorumNotReached,
    #[msg("Requested limit exceeds the pool's free capital")]
    LimitExceedsFreeCapital,
    #[msg("New policies are paused")]
    NewPoliciesPaused,
    /// Every amount in this program is money. A silent wrap would move funds
    /// nobody authorized, so arithmetic is checked and failure is an error, not
    /// a saturating fallback.
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Quorum must be above zero and at most 10000 basis points")]
    InvalidQuorum,
    #[msg("Duration must be positive")]
    InvalidDuration,
    #[msg("A covered protocol needs at least one privileged address")]
    NoPrivilegedAddresses,
    #[msg("Privileged address appears twice")]
    DuplicatePrivilegedAddress,
}
