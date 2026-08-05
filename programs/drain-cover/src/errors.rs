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
    #[msg("Amount must be positive")]
    AmountMustBePositive,
    #[msg("Policy limit and period must be positive and ordered")]
    InvalidPolicyTerms,
    #[msg("Retention at or above the limit would make the cover nominal")]
    RetentionAtOrAboveLimit,
    #[msg("Policy period has already ended")]
    PolicyEndsInThePast,
    #[msg("Policy premium must be paid at issuance")]
    PremiumRequired,
    /// The entry becomes effective only after `declaration_delay` (FR-031), so a
    /// window that closes by then covers nothing at all. Refused at submission
    /// rather than stored: the protocol would otherwise believe an operation is
    /// declared while every attestor sees it as undeclared.
    #[msg("Declaration window closes before the entry takes effect")]
    DeclarationExpiresBeforeEffective,
}
