import { AnchorProvider, BN, Wallet } from '@coral-xyz/anchor'
import { createProgram } from '@mandate/sdk'
import {
  type AccountInfo,
  type Connection,
  Keypair,
  type ProgramAccountChangeCallback,
  type ProgramAccountSubscriptionConfig,
  type PublicKey,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { createProtocolSource } from './chain'
import { type ProtocolSource, createProtocolTracker } from './protocols'
import type { WatchedAddress } from './watch'

const entry = (protocol: string, address: string): WatchedAddress => ({ protocol, address })
const FIRST = [entry('ProtocolA', 'AdminA')]
const SECOND = [entry('ProtocolB', 'AdminB')]

const quietLogger = () => {
  const errors: string[] = []
  return {
    errors,
    logger: { info: () => {}, error: (_: unknown, message: string) => void errors.push(message) },
  }
}

/** A registry the test edits by hand, and a watcher that only records what it was told. */
const fakes = () => {
  const order: string[] = []
  let registry: WatchedAddress[] = [...FIRST]
  let failList = false
  let notify: ((entries: WatchedAddress[]) => void) | null = null
  const reported: WatchedAddress[][] = []

  const source: ProtocolSource = {
    list: async () => {
      order.push('list')
      if (failList) throw new Error('rpc down')
      return registry
    },
    subscribe: async (handler) => {
      order.push('subscribe')
      notify = handler
      return async () => {
        order.push('unsubscribe')
        notify = null
      }
    },
  }
  const watcher = {
    watch: async (entries: readonly WatchedAddress[]) => {
      reported.push([...entries])
      return entries.length
    },
  }
  return {
    source,
    watcher,
    order,
    reported,
    register: (entries: WatchedAddress[]) => {
      registry = [...registry, ...entries]
    },
    notify: (entries: WatchedAddress[]) => notify?.(entries),
    failList: (fail: boolean) => {
      failList = fail
    },
  }
}

describe('createProtocolTracker', () => {
  // The other order would leave a window where a registration is in neither.
  it('subscribes before its first read, and that read is the starting list', async () => {
    const world = fakes()
    const tracker = createProtocolTracker({ ...world, ...quietLogger() })
    await tracker.start()
    await tracker.stop()

    expect(world.order).toEqual(['subscribe', 'list', 'unsubscribe'])
    expect(world.reported).toEqual([FIRST])
  })

  it('fails to start when the registry cannot be read, rather than watch nothing', async () => {
    const world = fakes()
    world.failList(true)
    const tracker = createProtocolTracker({ ...world, ...quietLogger() })
    await expect(tracker.start()).rejects.toThrow('rpc down')
  })

  it('hands a registration the subscription reports straight to the watcher', async () => {
    const world = fakes()
    const tracker = createProtocolTracker({ ...world, ...quietLogger() })
    await tracker.start()

    world.notify(SECOND)
    await tracker.stop()
    expect(world.reported).toEqual([FIRST, SECOND])
  })

  it('finds on the rescan a registration whose notification was lost', async () => {
    const world = fakes()
    const tracker = createProtocolTracker({ ...world, ...quietLogger() })
    await tracker.start()

    world.register(SECOND)
    await tracker.rescan()
    await tracker.stop()
    expect(world.reported.at(-1)).toEqual([...FIRST, ...SECOND])
  })

  it('logs a rescan that failed and carries on with the next one', async () => {
    const world = fakes()
    const { errors, logger } = quietLogger()
    const tracker = createProtocolTracker({ ...world, logger })
    await tracker.start()

    world.failList(true)
    await expect(tracker.rescan()).resolves.toBeUndefined()
    world.failList(false)
    await tracker.rescan()
    await tracker.stop()

    expect(errors).toEqual(['could not read the protocol registry'])
    expect(world.reported).toHaveLength(2)
  })

  it('never runs two rescans at once', async () => {
    const world = fakes()
    const tracker = createProtocolTracker({ ...world, ...quietLogger() })
    await tracker.start()
    const reads = world.order.length

    await Promise.all([tracker.rescan(), tracker.rescan()])
    await tracker.stop()
    expect(world.order.slice(reads).filter((step) => step === 'list')).toHaveLength(1)
  })
})

describe('createProtocolSource — the subscription', () => {
  const program = createProgram(
    new AnchorProvider(
      { rpcEndpoint: 'http://127.0.0.1:1' } as unknown as Connection,
      new Wallet(Keypair.generate()),
      {},
    ),
  )

  /** A `Connection` that only knows program-account subscriptions. */
  const fakeConnection = () => {
    let callback: ProgramAccountChangeCallback | null = null
    let config: ProgramAccountSubscriptionConfig | undefined
    const removed: number[] = []
    const connection = {
      onProgramAccountChange: (
        _program: PublicKey,
        handler: ProgramAccountChangeCallback,
        subscription?: ProgramAccountSubscriptionConfig,
      ) => {
        callback = handler
        config = subscription
        return 17
      },
      removeProgramAccountChangeListener: async (id: number) => void removed.push(id),
    } as unknown as Connection
    return {
      connection,
      removed,
      config: () => config,
      push: (accountId: PublicKey, data: Buffer) =>
        callback?.({ accountId, accountInfo: { data } as AccountInfo<Buffer> }, { slot: 1 }),
    }
  }

  const protocolAccount = async (privileged: PublicKey[]) =>
    program.coder.accounts.encode('protocol', {
      authority: Keypair.generate().publicKey,
      treasury: Keypair.generate().publicKey,
      privileged,
      pool: Keypair.generate().publicKey,
      newPoliciesPaused: false,
      nextPolicySeq: new BN(0),
      nextDeclarationSeq: new BN(0),
      incidentCount: new BN(0),
    })

  // A filter that matched nothing would not fail: it would report no registration ever.
  it('filters on the Protocol discriminator from the IDL', async () => {
    const chain = fakeConnection()
    await createProtocolSource({ program, connection: chain.connection }).subscribe(() => {})
    const data = await protocolAccount([])

    const memcmp = chain.config()?.filters?.[0]
    expect(memcmp).toEqual({ memcmp: { offset: 0, bytes: expect.any(String) } })
    expect(chain.config()?.commitment).toBe('confirmed')
    expect(program.coder.accounts.memcmp('protocol').bytes).toBe(
      (memcmp as { memcmp: { bytes: string } }).memcmp.bytes,
    )
    expect(data.subarray(0, 8)).toEqual(
      Buffer.from(
        program.idl.accounts?.find((account) => account.name === 'protocol')?.discriminator ?? [],
      ),
    )
  })

  it('reports every privileged address of a protocol account it is notified about', async () => {
    const chain = fakeConnection()
    const seen: WatchedAddress[][] = []
    const stop = await createProtocolSource({ program, connection: chain.connection }).subscribe(
      (entries) => seen.push(entries),
    )
    const protocol = Keypair.generate().publicKey
    const admins = [Keypair.generate().publicKey, Keypair.generate().publicKey]

    chain.push(protocol, await protocolAccount(admins))
    chain.push(protocol, Buffer.from('not a protocol account at all'))
    await stop()

    expect(seen).toEqual([
      admins.map((admin) => ({ protocol: protocol.toBase58(), address: admin.toBase58() })),
    ])
    expect(chain.removed).toEqual([17])
  })
})
