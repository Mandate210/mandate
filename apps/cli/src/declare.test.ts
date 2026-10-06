import { describe, expect, it, vi } from 'vitest'
import { USAGE, run } from './declare'

// What `run` decides before it reaches an RPC. Everything past that point is in
// `tests/declare-cli.itest.ts`, against a real validator.
const capture = () => {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err }
}

describe('run', () => {
  it('prints usage on --help and exits 0', async () => {
    const { io, out } = capture()
    expect(await run(['--help'], io)).toBe(0)
    expect(out).toEqual([USAGE])
  })

  it('exits 2 on a command line it cannot run', async () => {
    for (const argv of [
      [],
      ['--nope'],
      ['list', 'extra'],
      ['frobnicate', '--rpc', 'http://127.0.0.1:1'],
    ]) {
      const { io } = capture()
      expect(await run(argv, io), argv.join(' ')).toBe(2)
    }
  })

  it('wants an RPC named, and never picks one itself', async () => {
    // Empty counts as unset, the same as a missing variable.
    vi.stubEnv('SOLANA_RPC_URL', '')
    try {
      const { io, err } = capture()
      expect(await run(['list', '--protocol', '11111111111111111111111111111111'], io)).toBe(2)
      expect(err.join('\n')).toMatch(/SOLANA_RPC_URL/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
