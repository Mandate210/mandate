//! Account layouts. One file per account; the model of record is
//! `docs/PLAN.md` → «Модель даних».
//!
//! Sizes come from `#[derive(InitSpace)]` rather than hand arithmetic, and the
//! test at the bottom pins every one of them. That test exists because account
//! size is not a detail here: rent and fees per incident are capped at 1 USD by
//! SC-008, and an account that quietly grows is exactly how such a budget is
//! lost.

pub mod attestation;
pub mod attestor;
pub mod config;
pub mod declaration;
pub mod incident;
pub mod policy;
pub mod pool;
pub mod protocol;
pub mod underwriter_position;

pub use attestation::*;
pub use attestor::*;
pub use config::*;
pub use declaration::*;
pub use incident::*;
pub use policy::*;
pub use pool::*;
pub use protocol::*;
pub use underwriter_position::*;

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{Discriminator, Space};

    /// `INIT_SPACE` excludes the account discriminator; this is what `space =`
    /// has to add on top of it.
    fn on_chain_size<T: Discriminator + Space>() -> usize {
        T::DISCRIMINATOR.len() + T::INIT_SPACE
    }

    #[test]
    fn layouts_are_the_size_they_are_meant_to_be() {
        // admin 32 + asset_mint 32 + delay 8 + window 8 + quorum 2 + attestors 2
        //   + bond 8 + paused 1
        assert_eq!(Config::INIT_SPACE, 93);
        // authority 32 + treasury 32 + privileged (4 + 16*32) + pool 32 + paused 1
        //   + three u64 sequence counters
        assert_eq!(Protocol::INIT_SPACE, 637);
        // vault 32 + assets 8 + shares 8 + locked 8 + open 4 + acc 16 + bump 1
        assert_eq!(Pool::INIT_SPACE, 77);
        // shares 8 + checkpoint 16 + pending 8 + unlock 8
        assert_eq!(UnderwriterPosition::INIT_SPACE, 40);
        // limit 8 + retention 8 + remaining 8 + start 8 + end 8 + premium 8
        //   + beneficiary 32 + status 1
        assert_eq!(Policy::INIT_SPACE, 81);
        // program 32 + discriminator 8 + not_before 8 + not_after (1+8)
        //   + moves_funds 1 + submitted 8 + effective 8 + revoked (1+8).
        // The two 9s are the point of this line: `Option<i64>` is a tag byte plus
        // the payload, so a permanent entry costs the same as a bounded one.
        assert_eq!(DeclarationEntry::INIT_SPACE, 83);
        // authority 32 + epoch 8 + in_set 1 + stake 8 + agreed 4 + disagreed 4
        assert_eq!(Attestor::INIT_SPACE, 57);
        // policy 32 + trigger_sig 64 + opener 32 + bond 8 + opened 8 + epoch 8
        //   + deadline 8 + set_size 2 + votes 2+2 + status 1 + payout 8 + shortfall 8
        assert_eq!(Incident::INIT_SPACE, 183);
        // verdict 1 + submitted_at 8
        assert_eq!(Attestation::INIT_SPACE, 9);
    }

    /// The two accounts an incident creates, and therefore the two that SC-008
    /// pays rent on. T064 turns these numbers into a lamport ceiling; changing
    /// them changes the cost of every incident.
    #[test]
    fn an_incident_allocates_a_known_number_of_bytes() {
        assert_eq!(on_chain_size::<Incident>(), 191);
        assert_eq!(on_chain_size::<Attestation>(), 17);
    }
}
