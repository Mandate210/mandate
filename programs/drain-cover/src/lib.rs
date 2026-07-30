use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

// Derived from target/deploy/drain_cover-keypair.json by `anchor keys sync`, and
// duplicated in Anchor.toml (both clusters) and .env.example, where nothing
// cross-checks it but tests/config-consistency.test.ts. A wrong id here deploys to,
// or talks to, an address nobody controls — and fails silently, because each file
// is individually valid. `anchor keys sync` only rewrites the configured cluster,
// so the other one is updated by hand.
declare_id!("DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P");

#[program]
pub mod drain_cover {
    use super::*;

    // Instructions are added in Phase 4, one task per instruction (docs/TASKS.md).
    // Ordering follows the user stories in docs/SPEC.md: US1 first.
    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
