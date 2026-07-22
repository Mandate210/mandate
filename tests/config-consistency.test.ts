import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

const extract = (source: string, pattern: RegExp): string | null =>
  pattern.exec(source)?.[1] ?? null

// The program id is duplicated in three places that no compiler cross-checks.
// A mismatch deploys to, or talks to, an address nobody controls — and it fails
// silently, because each file is individually valid.
describe('program id stays in sync', () => {
  const fromRust = extract(
    read('programs/drain-cover/src/lib.rs'),
    /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/,
  )
  const fromAnchorLocalnet = extract(
    read('Anchor.toml'),
    /\[programs\.localnet\][\s\S]*?drain_cover\s*=\s*"([1-9A-HJ-NP-Za-km-z]+)"/,
  )
  const fromAnchorDevnet = extract(
    read('Anchor.toml'),
    /\[programs\.devnet\][\s\S]*?drain_cover\s*=\s*"([1-9A-HJ-NP-Za-km-z]+)"/,
  )
  const fromEnvExample = extract(read('.env.example'), /^PROGRAM_ID=(.+)$/m)

  it('is declared in the Rust program', () => {
    expect(fromRust).not.toBeNull()
  })

  it('matches between lib.rs and Anchor.toml localnet', () => {
    expect(fromAnchorLocalnet).toBe(fromRust)
  })

  it('matches between lib.rs and Anchor.toml devnet', () => {
    expect(fromAnchorDevnet).toBe(fromRust)
  })

  it('matches between lib.rs and .env.example', () => {
    expect(fromEnvExample).toBe(fromRust)
  })
})
