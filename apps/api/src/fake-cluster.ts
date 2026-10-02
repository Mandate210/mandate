// A cluster that holds the fixture world (`fixtures.ts`), for tests that run the real
// indexer against it — the indexer's own, and the routes', which read what it wrote.

import type { ObservedTransaction } from '@mandate/shared'
import {
  addresses,
  attestTx,
  attestationOf,
  keys,
  openTx,
  registerTx,
  resolveTx,
  worldAccounts,
} from './fixtures'
import type { IndexerRpc } from './indexer'

/** Cluster time at slot 100, where the fake cluster starts: after every fixture event. */
export const CLUSTER_TIME = 1_720_000_000

export const A = attestationOf(keys.attestorA).toBase58()
export const B = attestationOf(keys.attestorB).toBase58()
export const INCIDENT = addresses.incident.toBase58()
export const PROTOCOL = addresses.protocol.toBase58()

/**
 * A cluster that holds the fixture world and remembers what was asked of it. Each
 * account's history is newest first, as `getSignaturesForAddress` returns it.
 */
export const fakeCluster = async () => {
  let accounts = await worldAccounts()
  let slot = 100
  const transactions = new Map<string, ObservedTransaction>([
    ['SigRegister', registerTx()],
    ['SigOpen', openTx()],
    ['SigAttestA', attestTx(keys.attestorA, 'SigAttestA')],
    ['SigAttestB', attestTx(keys.attestorB, 'SigAttestB')],
    ['SigResolve', resolveTx()],
  ])
  const history = new Map<string, string[]>([
    [PROTOCOL, ['SigResolve', 'SigOpen', 'SigRegister']],
    [INCIDENT, ['SigResolve', 'SigAttestB', 'SigAttestA', 'SigOpen']],
    [A, ['SigAttestA']],
    [B, ['SigAttestB']],
  ])
  const calls: string[] = []
  let logs: ((signature: string, failed: boolean) => void) | undefined

  const rpc: IndexerRpc = {
    programAccounts: async () => {
      calls.push('programAccounts')
      return { slot, accounts }
    },
    accounts: async (wanted) => {
      calls.push('accounts')
      return { slot, accounts: accounts.filter((account) => wanted.includes(account.address)) }
    },
    transaction: async (signature) => {
      calls.push(`transaction:${signature}`)
      return transactions.get(signature) ?? null
    },
    signatures: async (address) => {
      calls.push(`signatures:${address}`)
      return [...(history.get(address) ?? [])]
    },
    signatureSlot: async () => 90,
    // The trigger's slot, and the slots the cluster is read at: the world's clock stands
    // at CLUSTER_TIME on slot 100 and moves a second a slot from there.
    blockTime: async (at) =>
      at === 90 ? 1_709_999_999 : at >= 100 ? CLUSTER_TIME + (at - 100) : null,
    mintDecimals: async () => 6,
    onProgramLogs: (callback) => {
      calls.push('subscribe')
      logs = callback
      return () => {
        logs = undefined
      }
    },
  }

  return {
    rpc,
    calls,
    setSlot: (next: number) => {
      slot = next
    },
    replace: async (address: string, data: Buffer) => {
      accounts = accounts.map((account) =>
        account.address === address ? { address, data } : account,
      )
    },
    emit: (signature: string, failed = false) => logs?.(signature, failed),
    subscribed: () => logs !== undefined,
  }
}
