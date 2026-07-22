use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

// Placeholder from the Anchor template. Replace with `anchor keys sync` before the
// first deploy — the guard in `pre-push` does not check this, and a wrong id here
// silently deploys to an address nobody controls.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

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
