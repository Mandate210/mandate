use anchor_lang::prelude::*;

pub const ATTESTOR_SEED: &[u8] = b"attestor";

/// An independent observer entitled to classify privileged transactions. The
/// authority is in the PDA seeds; the field repeats it so the account can be read
/// without rederiving the address.
#[account]
#[derive(InitSpace)]
pub struct Attestor {
    pub authority: Pubkey,
    /// Membership starts with the next epoch, never mid-incident: an attestation
    /// is only accepted from a member of the set as it stood when the incident
    /// opened (FR-008).
    pub active_from_epoch: u64,
    /// In the set right now. A fresh account reads `false`, which is what it is:
    /// an address nobody has admitted. Removal clears the flag rather than closing
    /// the account, so `agreed`/`disagreed` — and, from US3, the stake — survive a
    /// removal and a later re-admission.
    pub in_set: bool,
    /// Zero while the set is a permissive list. Stake, rewards and slashing
    /// arrive with US3 and change only how the set is formed (FR-021).
    pub stake: u64,
    /// Agreements and disagreements with settled decisions. Public record now,
    /// input to slashing later (FR-022, FR-023).
    pub agreed: u32,
    pub disagreed: u32,
}

impl Attestor {
    /// Whether this attestor counts as part of the set for an incident opened in
    /// `epoch` (FR-008).
    ///
    /// The two halves answer different questions on purpose. `active_from_epoch` is
    /// read against the epoch the incident *opened* in, so nobody admitted after the
    /// fact can vote on it. `in_set` is read as it stands now, because removal takes
    /// effect at once — an attestor the admin has just taken out does not get to
    /// finish voting on incidents already in flight.
    pub fn is_member_at(&self, epoch: u64) -> bool {
        self.in_set && self.active_from_epoch <= epoch
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attestor(active_from_epoch: u64, in_set: bool) -> Attestor {
        Attestor {
            authority: Pubkey::new_unique(),
            active_from_epoch,
            in_set,
            stake: 0,
            agreed: 0,
            disagreed: 0,
        }
    }

    #[test]
    fn is_a_member_from_the_epoch_membership_started() {
        assert!(attestor(5, true).is_member_at(5));
        assert!(attestor(5, true).is_member_at(6));
    }

    #[test]
    fn is_not_a_member_of_an_incident_older_than_the_membership() {
        // Admitted while this incident was already open: FR-008 keeps them out of it.
        assert!(!attestor(5, true).is_member_at(4));
    }

    #[test]
    fn is_not_a_member_once_removed() {
        assert!(!attestor(5, false).is_member_at(6));
    }
}
