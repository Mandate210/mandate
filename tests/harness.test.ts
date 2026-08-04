import { describe, expect, it, vi } from 'vitest'
import { ASSET_DECIMALS, assertLocalEndpoint, asset, testRpcUrl } from './harness'

// The network parts of the harness are exercised by the integration suite
// (`*.itest.ts`, run against a validator — see CLAUDE.md → Commands). What is
// checked here is the logic that must hold before a validator is involved at all.

describe('asset amounts', () => {
  it('scales whole units by the asset decimals', () => {
    expect(asset(1)).toBe(10n ** BigInt(ASSET_DECIMALS))
    expect(asset(3_000_000)).toBe(3_000_000_000_000n)
    expect(asset(0)).toBe(0n)
  })

  // Fractional dollars would silently truncate, and the amount that reaches a
  // vault would not be the amount the test says it deposited.
  it('rejects fractional units', () => {
    expect(() => asset(0.5)).toThrow(/whole units/)
  })
})

describe('endpoint guard', () => {
  it('accepts loopback', () => {
    expect(() => assertLocalEndpoint('http://127.0.0.1:8899')).not.toThrow()
    expect(() => assertLocalEndpoint('http://localhost:8899')).not.toThrow()
  })

  // Airdropping and minting against a real cluster is either rate-limited noise
  // or live state. Neither belongs in a test run.
  it('refuses a remote cluster', () => {
    expect(() => assertLocalEndpoint('https://api.devnet.solana.com')).toThrow(/Refusing/)
    expect(() => assertLocalEndpoint('https://devnet.helius-rpc.com/?api-key=k')).toThrow(
      /Refusing/,
    )
  })

  it('defaults to the local validator when nothing is configured', () => {
    vi.stubEnv('TEST_RPC_URL', '')
    try {
      expect(testRpcUrl()).toBe('http://127.0.0.1:8899')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
