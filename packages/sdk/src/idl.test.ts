import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID_FROM_IDL } from './idl'
import committedIdl from './idl/drain_cover.json'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8')

// The program id now lives in a fourth place: the IDL copy in this package. Unlike
// the other three it is a build artifact, so it cannot drift on its own — but it can
// be stale, which looks identical from the outside.
describe('the committed IDL', () => {
  it('carries the same program id as declare_id!', () => {
    const fromRust = /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(
      read('programs/drain-cover/src/lib.rs'),
    )?.[1]

    expect(fromRust).toBeDefined()
    expect(PROGRAM_ID_FROM_IDL).toBe(fromRust)
  })

  // Only meaningful where the program has been built. On the CI typescript job
  // there is no target/, and that is the whole reason the copy is committed.
  it('matches the build output when there is one', () => {
    const generated = join(repoRoot, 'target', 'idl', 'drain_cover.json')
    if (!existsSync(generated)) return

    expect(committedIdl).toEqual(JSON.parse(readFileSync(generated, 'utf8')))
  })
})
