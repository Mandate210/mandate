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
    /// Widening is exactly what `declaration_delay` slows down, so it goes through
    /// a new entry (FR-031) instead of an edit that lands at once.
    #[msg("A revised declaration window must be narrower than the one it replaces")]
    DeclarationWindowNotNarrower,
    /// Narrowing applies from now on. A window pulled into the past would
    /// un-declare operations already performed while the entry was effective —
    /// an incident, and a payout, against a protocol that did nothing wrong.
    #[msg("A narrowed declaration window may not end in the past")]
    NarrowedWindowEndsInThePast,
    /// Refused rather than treated as a no-op: a second admission would push
    /// `active_from_epoch` forward and silently disarm an attestor the admin
    /// believes is voting.
    #[msg("Attestor is already in the set")]
    AttestorAlreadyInSet,
    #[msg("Attestor is not in the set")]
    AttestorNotInSet,
    /// Quorum is a share of the set (FR-010), and a share of nothing is nothing —
    /// an incident opened against an empty set would clear its bar with no
    /// attestations at all.
    #[msg("The attestor set is empty, so no incident can reach quorum")]
    AttestorSetEmpty,
    /// The deadline second itself still belongs to the attestation window
    /// (`validate_attest`), so expiry starts the second after it.
    #[msg("Incident deadline has not passed yet")]
    IncidentDeadlineNotReached,
    /// Refused so that closing an incident can never be raced ahead of a payout the
    /// quorum has already decided (FR-012).
    #[msg("Quorum was reached on a policy in force, so this incident settles rather than expires")]
    IncidentPayable,
    /// Rounding is down, so a deposit worth less than one share would join the
    /// pool's capital with nothing representing it — capital given away rather
    /// than underwritten.
    #[msg("Deposit is too small to be worth one share of this pool")]
    DepositTooSmall,
    /// Capital put in through `service_fund_pool` (T014) belongs to nobody, and a
    /// first deposit priced one-for-one would take ownership of it. Refused rather
    /// than absorbed: the instruction that creates this state is removed in T036,
    /// and until then a pool is either seeded or underwritten, never both.
    #[msg("Pool holds capital that no share represents, so it cannot take a first deposit")]
    PoolHasUnsharedCapital,
    /// A payout can take a pool's capital to exactly zero while shares remain
    /// outstanding. There is then no price at which to issue new ones, and minting
    /// at par would split the new capital with shares that are worth nothing.
    #[msg("Pool has shares outstanding but no capital, so a deposit cannot be priced")]
    PoolWipedOut,
}
