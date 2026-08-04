// Copies the two build artifacts `anchor build` writes into target/ — which is
// gitignored — into this package, where they are committed.
//
// They have to be committed: the CI `typescript` job has no Rust and no Anchor, so
// anything importing straight from target/ would only typecheck on a machine that
// had just built the program. The drift guard is packages/sdk/src/idl.test.ts.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const packageRoot = join(import.meta.dirname, '..')
const repoRoot = join(packageRoot, '..', '..')
const target = join(repoRoot, 'target')

const copies = [
  [join(target, 'idl', 'drain_cover.json'), join(packageRoot, 'src', 'idl', 'drain_cover.json')],
  [join(target, 'types', 'drain_cover.ts'), join(packageRoot, 'src', 'idl', 'drain_cover.ts')],
]

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.error(`Missing ${from}. Run \`anchor build\` in WSL first.`)
    process.exit(1)
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  console.log(`synced ${to}`)
}
