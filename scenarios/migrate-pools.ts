// Grows every pool written before T082 to the current layout (`migrate_pool`).
//
//   pnpm --filter @mandate/scenarios migrate-pools                    # local validator, dry run
//   pnpm --filter @mandate/scenarios migrate-pools --devnet           # devnet, dry run
//   pnpm --filter @mandate/scenarios migrate-pools --devnet --apply   # devnet, for real
//
// Run once, right after the program upgrade that brought T082 and before anything
// else touches the deployment: an old pool is unreadable to every other instruction,
// to the API and to the attestors until it has been grown. Idempotent — a pool
// already at the current length is reported and left alone, so a run cut short by a
// devnet hiccup is finished by running it again.
//
// Pools are found through their protocols, not by scanning for the old length: the
// pool's seeds are its protocol's key, which the pool itself does not record, and the
// protocol's layout did not change.

import { LEGACY_POOL_SIZE, POOL_SIZE, createProgram } from '@mandate/sdk'
import { setupTestEnv } from '@mandate/tests/harness'
import { SystemProgram } from '@solana/web3.js'
import { setupDevnetEnv, withRetry } from './devnet'

const say = (message: string): void => {
  console.log(message)
}

const main = async (): Promise<number> => {
  const devnet = process.argv.includes('--devnet')
  const apply = process.argv.includes('--apply')
  const env = devnet ? await setupDevnetEnv() : await setupTestEnv()
  const program = createProgram(env.provider)

  say(`mandate — migrate pools to the T082 layout (${devnet ? 'devnet' : 'local'})`)
  say(`program ${program.programId.toBase58()}`)
  say(`payer   ${env.payer.publicKey.toBase58()}${apply ? '' : '   (dry run: --apply to send)'}\n`)

  const protocols = await withRetry(() => program.account.protocol.all())
  let legacy = 0
  let migrated = 0
  let unexpected = 0

  for (const { publicKey: protocol, account } of protocols) {
    const pool = account.pool
    const info = await withRetry(() => env.connection.getAccountInfo(pool))
    const length = info?.data.length
    const label = `${protocol.toBase58().slice(0, 8)}… pool ${pool.toBase58()}`

    if (length === POOL_SIZE) {
      say(`  current   ${label}`)
      continue
    }
    if (length !== LEGACY_POOL_SIZE || info?.owner.equals(program.programId) !== true) {
      // Neither layout, or not the program's: nothing this script should write to.
      say(`  ???       ${label} — ${length ?? 'missing'} bytes, owner ${info?.owner.toBase58()}`)
      unexpected += 1
      continue
    }

    legacy += 1
    if (!apply) {
      say(`  legacy    ${label}`)
      continue
    }
    const signature = await withRetry(() =>
      program.methods
        .migratePool()
        .accountsPartial({
          payer: env.payer.publicKey,
          protocol,
          pool,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
    )
    const after = await withRetry(() => env.connection.getAccountInfo(pool))
    if (after?.data.length !== POOL_SIZE) {
      say(`  FAILED    ${label} — still ${after?.data.length} bytes after ${signature}`)
      unexpected += 1
      continue
    }
    // Decodes with the current layout now, which is what every other reader needs.
    await program.account.pool.fetch(pool)
    migrated += 1
    say(`  migrated  ${label}  ${signature}`)
  }

  say(
    `\n${protocols.length} protocols: ${legacy} legacy pools, ${migrated} migrated, ${unexpected} unexpected`,
  )
  return unexpected === 0 ? 0 : 1
}

process.exitCode = await main()
