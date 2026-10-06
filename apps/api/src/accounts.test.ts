import { describe, expect, it } from 'vitest'
import {
  type DecodedAccount,
  type Hints,
  decodeAccount,
  factsFromTransaction,
  relate,
  toRows,
} from './accounts'
import {
  addresses,
  attestTx,
  attestationOf,
  encode,
  fields,
  instruction,
  keys,
  legacyResolveTx,
  openTx,
  programId,
  registerTx,
  settlingAttestTx,
  sig,
  transaction,
  worldAccounts,
} from './fixtures'

const decodedWorld = async (): Promise<DecodedAccount[]> =>
  (await worldAccounts()).map(({ address, data }) => {
    const decoded = decodeAccount(address, data)
    if (decoded === null) throw new Error(`fixture ${address} did not decode`)
    return decoded
  })

const attestorsOf = (accounts: DecodedAccount[]) =>
  accounts
    .filter((account) => account.kind === 'Attestor')
    .map((account) => (account.fields.authority as { toBase58(): string }).toBase58())

describe('decodeAccount', () => {
  it('names the account by its discriminator', async () => {
    const decoded = decodeAccount('x', await encode('Pool', fields.pool()))
    expect(decoded?.kind).toBe('Pool')
  })

  it('returns null for bytes that are not one of ours, rather than throwing', () => {
    expect(decodeAccount('x', Buffer.alloc(64, 7))).toBeNull()
  })
})

describe('relate — a census places every account from the chain alone', () => {
  it('finds each parent by rebuilding the address from its seeds', async () => {
    const accounts = await decodedWorld()
    const hints: Hints = new Map()
    relate(programId, accounts, hints, { attestors: attestorsOf(accounts) })

    const protocol = addresses.protocol.toBase58()
    expect(hints.get(addresses.pool.toBase58())).toEqual({ protocol })
    expect(hints.get(addresses.policy0.toBase58())).toEqual({ protocol, seq: '0' })
    expect(hints.get(addresses.policy1.toBase58())).toEqual({ protocol, seq: '1' })
    expect(hints.get(addresses.declaration0.toBase58())).toEqual({ protocol, seq: '0' })
    expect(hints.get(addresses.incident.toBase58())).toEqual({ protocol })
    expect(hints.get(attestationOf(keys.attestorB).toBase58())).toEqual({
      incident: addresses.incident.toBase58(),
      attestor: keys.attestorB.toBase58(),
    })
  })

  it('places no policy the protocol counter does not reach', async () => {
    const accounts = await decodedWorld()
    const protocol = accounts.find((account) => account.kind === 'Protocol')
    if (protocol === undefined) throw new Error('no protocol')
    protocol.fields.next_policy_seq = { toString: () => '1' }
    const hints: Hints = new Map()
    relate(programId, accounts, hints)
    expect(hints.get(addresses.policy1.toBase58())).toBeUndefined()
  })

  it('leaves an attestation unplaced when its attestor is not among those given', async () => {
    const accounts = await decodedWorld()
    const hints: Hints = new Map()
    relate(programId, accounts, hints, { attestors: [keys.attestorA.toBase58()] })
    expect(hints.get(attestationOf(keys.attestorB).toBase58())).toBeUndefined()
  })
})

describe('toRows', () => {
  const rowsOf = async (options: { protocolId?: boolean; decimals?: number | undefined } = {}) => {
    const accounts = await decodedWorld()
    const hints: Hints = new Map()
    if (options.protocolId !== false) {
      hints.set(addresses.protocol.toBase58(), { protocolId: keys.protocolId.toBase58() })
    }
    relate(programId, accounts, hints, { attestors: attestorsOf(accounts) })
    return toRows(programId, accounts, hints, 42, 'decimals' in options ? options.decimals : 6)
  }

  it('writes a row for every cached account of a fully placed world', async () => {
    const { rows, unplaced } = await rowsOf()
    expect(unplaced).toEqual([])
    expect(
      Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, list.length])),
    ).toEqual({
      config: 1,
      protocols: 1,
      pools: 1,
      policies: 2,
      declarations: 1,
      incidents: 1,
      attestations: 2,
    })
  })

  it('carries u64 as exact decimal strings and enums as the database spells them', async () => {
    const { rows } = await rowsOf()
    expect(rows.pools[0]?.totalAssets).toBe('18446744073709551615')
    expect(rows.incidents[0]?.status).toBe('paid_out')
    expect(rows.policies.map((row) => row.status).sort()).toEqual(['active', 'pending'])
    expect(rows.attestations.map((row) => row.verdict).sort()).toEqual([
      'authorized',
      'unauthorized',
    ])
  })

  it('writes the trigger signature in base58 and the discriminator in hex', async () => {
    const { rows } = await rowsOf()
    expect(rows.incidents[0]?.triggerSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
    expect(rows.declarations[0]).toMatchObject({
      ixDiscriminator: 'deadbeef00000001',
      notAfter: null,
      revokedAt: 1_750_000_000,
      instructionName: null,
    })
  })

  it('stamps every row with the slot the accounts were read at', async () => {
    const { rows } = await rowsOf()
    for (const list of Object.values(rows)) {
      for (const row of list) expect(row.updatedSlot).toBe(42)
    }
  })

  it('holds back a protocol whose protocol_id is not known, rather than guessing one', async () => {
    const { rows, unplaced } = await rowsOf({ protocolId: false })
    expect(rows.protocols).toEqual([])
    expect(unplaced).toEqual([addresses.protocol.toBase58()])
    // Its children are still placed: they need the protocol's address, not its id.
    expect(rows.pools).toHaveLength(1)
  })

  it('holds back the config until the mint decimals are known', async () => {
    const { rows, unplaced } = await rowsOf({ decimals: undefined })
    expect(rows.config).toEqual([])
    expect(unplaced).toContain(addresses.config.toBase58())
  })

  it('refuses a Config that is not at the singleton address', async () => {
    const config = decodeAccount('NotTheConfig', await encode('Config', fields.config()))
    if (config === null) throw new Error('no config')
    const { rows, unplaced } = toRows(programId, [config], new Map(), 1, 6)
    expect(rows.config).toEqual([])
    expect(unplaced).toEqual(['NotTheConfig'])
  })
})

describe('factsFromTransaction', () => {
  const protocol = addresses.protocol.toBase58()

  it('reads protocol_id out of register_protocol', () => {
    const facts = factsFromTransaction(programId, registerTx())
    expect(facts.hints.get(protocol)).toEqual({ protocolId: keys.protocolId.toBase58() })
    expect(facts.hints.get(addresses.pool.toBase58())).toEqual({ protocol })
  })

  it('names the opening signature and the policy seq on open_incident', () => {
    const facts = factsFromTransaction(programId, openTx(sig('SigOpen')))
    expect(facts.hints.get(addresses.policy0.toBase58())).toEqual({ protocol, seq: '0' })
    expect(facts.hints.get(addresses.incident.toBase58())).toEqual({ protocol })
    expect(facts.provenance).toEqual([
      {
        table: 'incidents',
        address: addresses.incident.toBase58(),
        openedSignature: sig('SigOpen'),
      },
    ])
  })

  it('ties an attestation to its incident and attestor, with the signature', () => {
    const attestation = attestationOf(keys.attestorA).toBase58()
    const facts = factsFromTransaction(programId, attestTx(keys.attestorA, sig('SigAttest')))
    expect(facts.hints.get(attestation)).toEqual({
      incident: addresses.incident.toBase58(),
      attestor: keys.attestorA.toBase58(),
    })
    expect(facts.provenance).toEqual([
      { table: 'attestations', address: attestation, signature: sig('SigAttest') },
    ])
  })

  it('takes the vote that settled the incident as the payout, timed by its block', () => {
    const facts = factsFromTransaction(
      programId,
      settlingAttestTx(keys.attestorA, sig('SigDecide'), { blockTime: 1_710_000_070 }),
    )
    expect(facts.provenance).toContainEqual({
      table: 'incidents',
      address: addresses.incident.toBase58(),
      payoutSignature: sig('SigDecide'),
      payoutAt: 1_710_000_070,
    })
    expect(facts.touched).toContain(addresses.incident.toBase58())
  })

  // Every attestation is an `attest`: only the event tells the deciding one apart, and a
  // vote below the quorum must not be taken for a payout.
  it('does not take an ordinary vote for a payout', () => {
    const facts = factsFromTransaction(programId, attestTx(keys.attestorA, sig('SigAttest')))
    expect(facts.provenance.filter((fact) => fact.table === 'incidents')).toEqual([])
  })

  it('does not take a vote that closed the incident unpaid for a payout (FR-016)', () => {
    const facts = factsFromTransaction(
      programId,
      settlingAttestTx(keys.attestorA, sig('SigDecide'), { status: 'ClosedNoPayout' }),
    )
    expect(facts.provenance.filter((fact) => fact.table === 'incidents')).toEqual([])
  })

  // Paid before T078: the cache is disposable, so a census from nothing has to find
  // those payouts again by the instruction that made them.
  it('still takes a legacy resolve as the payout', () => {
    const facts = factsFromTransaction(programId, legacyResolveTx(sig('SigResolve'), 1_710_000_060))
    expect(facts.provenance).toEqual([
      {
        table: 'incidents',
        address: addresses.incident.toBase58(),
        payoutSignature: sig('SigResolve'),
        payoutAt: 1_710_000_060,
      },
    ])
  })

  it("ignores another program's instructions, even with our data in them", () => {
    const foreign = {
      ...instruction('attest', { verdict: { Unauthorized: {} } }, {}),
      programId: keys.declared.toBase58(),
    }
    const facts = factsFromTransaction(programId, transaction(sig('SigForeign'), [foreign]))
    expect(facts).toEqual({ touched: [], hints: new Map(), provenance: [] })
  })
})
