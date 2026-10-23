use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_lang::Discriminator;

use crate::errors::DrainCoverError;
use crate::state::{Pool, LEGACY_POOL_LEN, POOL_SEED};

/// Grows a pool written before T082 to the current layout (owner's decision
/// 2026-10-23): the two fields that keep the run of blocked time, which lets a
/// withdrawal window outlive an incident, are appended to every pool.
///
/// Permissionless, like `close_expired_incident`: it changes nothing a pool means,
/// only how much of it is on record, and an old pool is unusable by every other
/// instruction until it runs — nobody may be in a position to hold that back. The
/// caller pays the rent the extra bytes need.
#[derive(Accounts)]
pub struct MigratePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: only its key is used, as the seed that binds the pool below.
    pub protocol: UncheckedAccount<'info>,
    /// CHECK: not `Account<Pool>` — at the old length it does not deserialize, which
    /// is the whole reason this instruction exists. The address comes from the seeds;
    /// owner, discriminator and length are checked by `migrate_legacy_pool` and the
    /// handler.
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump)]
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// The current `Pool` for the bytes of an old one, or why they are not an old pool.
///
/// The old layout is the current one cut short, so the fields it has are read in
/// place and the new ones start at zero — «never blocked». The exception is a pool
/// migrated **during** an incident: when that run began is recorded nowhere, and it
/// is dated from the migration. Dating it earlier would let the incident revive
/// requests whose window had already closed before it.
pub fn migrate_legacy_pool(data: &[u8], now: i64) -> Result<Pool> {
    require!(
        data.len() == LEGACY_POOL_LEN,
        DrainCoverError::PoolNotLegacy
    );
    require!(
        data[..Pool::DISCRIMINATOR.len()] == *Pool::DISCRIMINATOR,
        DrainCoverError::PoolNotLegacy
    );

    let mut current = data.to_vec();
    current.resize(Pool::DISCRIMINATOR.len() + Pool::INIT_SPACE, 0);
    let mut pool = Pool::try_deserialize(&mut current.as_slice())?;
    if pool.open_incidents > 0 {
        pool.blocked_since = now;
    }
    Ok(pool)
}

pub fn handle_migrate_pool(ctx: Context<MigratePool>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = ctx.accounts.pool.to_account_info();
    require!(pool.owner == &crate::ID, DrainCoverError::PoolNotLegacy);

    let migrated = migrate_legacy_pool(&pool.try_borrow_data()?, now)?;

    let len = Pool::DISCRIMINATOR.len() + Pool::INIT_SPACE;
    let short = Rent::get()?
        .minimum_balance(len)
        .saturating_sub(pool.lamports());
    if short > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: pool.clone(),
                },
            ),
            short,
        )?;
    }

    pool.resize(len)?;
    migrated.try_serialize(&mut &mut pool.try_borrow_mut_data()?[..])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An old pool's bytes, written field by field the way the old program wrote them.
    fn legacy(open_incidents: u32) -> Vec<u8> {
        let mut data = Pool::DISCRIMINATOR.to_vec();
        data.extend_from_slice(&[7; 32]);
        data.extend_from_slice(&1_100u64.to_le_bytes());
        data.extend_from_slice(&1_000u64.to_le_bytes());
        data.extend_from_slice(&300u64.to_le_bytes());
        data.extend_from_slice(&open_incidents.to_le_bytes());
        data.push(254);
        assert_eq!(data.len(), LEGACY_POOL_LEN);
        data
    }

    fn refused(result: Result<Pool>) -> u32 {
        match result {
            Err(Error::AnchorError(e)) => e.error_code_number,
            Err(other) => panic!("expected a program error, got {other:?}"),
            Ok(_) => panic!("expected a refusal, got a migrated pool"),
        }
    }

    #[test]
    fn keeps_every_old_field_and_starts_the_new_ones_unblocked() {
        let pool = migrate_legacy_pool(&legacy(0), 5_000).unwrap();
        assert_eq!(pool.vault, Pubkey::new_from_array([7; 32]));
        assert_eq!(
            (pool.total_assets, pool.total_shares, pool.locked_limit),
            (1_100, 1_000, 300)
        );
        assert_eq!((pool.open_incidents, pool.bump), (0, 254));
        assert_eq!((pool.blocked_since, pool.unblocked_at), (0, 0));
    }

    #[test]
    fn a_pool_migrated_mid_incident_is_blocked_from_the_migration() {
        let pool = migrate_legacy_pool(&legacy(2), 5_000).unwrap();
        assert_eq!((pool.open_incidents, pool.blocked_since), (2, 5_000));
        // A request whose window closed before the migration stays closed.
        assert_eq!(pool.withdraw_lapses_at(4_000, 100).unwrap(), Some(4_100));
    }

    #[test]
    fn a_current_pool_is_refused() {
        let mut data = legacy(0);
        data.resize(Pool::DISCRIMINATOR.len() + Pool::INIT_SPACE, 0);
        assert_eq!(
            refused(migrate_legacy_pool(&data, 5_000)),
            u32::from(DrainCoverError::PoolNotLegacy)
        );
    }

    #[test]
    fn another_account_of_the_old_length_is_refused() {
        let mut data = legacy(0);
        data[0] ^= 0xff;
        assert_eq!(
            refused(migrate_legacy_pool(&data, 5_000)),
            u32::from(DrainCoverError::PoolNotLegacy)
        );
    }
}
