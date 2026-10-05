import {
  configResponseSchema,
  declarationsResponseSchema,
  entryStateAt,
  incidentDetailResponseSchema,
  poolsResponseSchema,
  protocolDetailResponseSchema,
} from '@mandate/shared'
import { describe, expect, it } from 'vitest'
import { fixtureSource } from './fixtureSource'
import { CONFIG, DECLARATIONS, INCIDENT_DETAIL, POOLS, PROTOCOL_DETAILS } from './fixtures'
import { timelineOf } from './incident'

/**
 * The demonstration data is held to the contract the real API will be held to, so
 * the day `web` switches source (T053), nothing on a page depends on a field the API
 * does not send.
 */
describe('fixtures', () => {
  it('parse as the responses the contract defines', () => {
    configResponseSchema.parse(CONFIG)
    poolsResponseSchema.parse(POOLS)
    for (const detail of PROTOCOL_DETAILS) protocolDetailResponseSchema.parse(detail)
    for (const declarations of DECLARATIONS) declarationsResponseSchema.parse(declarations)
    incidentDetailResponseSchema.parse(INCIDENT_DETAIL)
  })

  it('carry declaration states computed by the rule, at the moment they claim', () => {
    for (const { as_of, entries } of DECLARATIONS) {
      for (const entry of entries) {
        const raw = {
          programId: entry.program_id,
          ixDiscriminator: [...entry.ix_discriminator.matchAll(/../g)].map(([p]) =>
            Number.parseInt(p, 16),
          ),
          notBefore: entry.not_before,
          notAfter: entry.not_after,
          movesFunds: entry.moves_funds,
          submittedAt: entry.submitted_at,
          effectiveAt: entry.effective_at,
          revokedAt: entry.revoked_at,
        }
        expect(entry.state).toBe(entryStateAt(raw, as_of.unix_ts))
      }
    }
  })

  it('show a variety of states, or the declaration screen demonstrates nothing', () => {
    const states = new Set(DECLARATIONS.flatMap((d) => d.entries.map((e) => e.state)))
    expect(states.size).toBeGreaterThanOrEqual(3)
  })

  it('find no effective entry covering the trigger — which is why there is an incident', () => {
    // Every entry at the trigger belongs to other operations or is out of its window.
    const { entries } = INCIDENT_DETAIL.verification.declaration_at_trigger
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((e) => e.state !== 'effective')).toBe(true)
  })

  it('pay out only once the unauthorized tally reaches the quorum, and in a later transaction', () => {
    const events = timelineOf(INCIDENT_DETAIL)
    const quorum = events.find((e) => e.kind === 'attestation' && e.quorumReached)
    const payout = events.find((e) => e.kind === 'payout')
    expect(quorum).toBeDefined()
    expect(payout?.at).toBeGreaterThan(quorum?.at ?? Number.POSITIVE_INFINITY)
    // `resolve` is its own transaction, as on devnet — not the deciding attestation's.
    expect(INCIDENT_DETAIL.attestations.map((a) => a.signature)).not.toContain(
      INCIDENT_DETAIL.payout?.signature,
    )
  })
})

/**
 * One world at one moment: a page that read the pool from before the incident and the
 * incident from after it would contradict itself — capital still there that the
 * incident says it paid out.
 */
describe('the fixtures’ world', () => {
  const { incident, payout } = INCIDENT_DETAIL
  const hit = PROTOCOL_DETAILS.find((d) => d.protocol.address === incident.protocol)

  it('is read at one moment by every response', () => {
    const moments = new Set(
      [
        CONFIG.as_of,
        POOLS.as_of,
        INCIDENT_DETAIL.as_of,
        ...PROTOCOL_DETAILS.map((d) => d.as_of),
        ...DECLARATIONS.map((d) => d.as_of),
      ].map((asOf) => `${asOf.slot}:${asOf.unix_ts}`),
    )
    expect(moments.size).toBe(1)
  })

  it('shows the incident in its protocol’s history, and nowhere else', async () => {
    expect(hit?.protocol.incident_count).toBe(1)
    expect(hit?.recent_incidents).toEqual([incident])
    for (const other of PROTOCOL_DETAILS.filter((d) => d !== hit)) {
      expect(other.protocol.incident_count).toBe(0)
      expect(other.recent_incidents).toEqual([])
    }
    const listed = (await fixtureSource(`/incidents?protocol=${incident.protocol}`)) as {
      incidents: unknown[]
    }
    expect(listed.incidents).toEqual(hit?.recent_incidents)
  })

  it('has the pool and the policy as resolve leaves them after the payout', () => {
    // 3 000 000 limit, 600 000 retention: 2 400 000 paid from 4 200 000 of capital, and
    // the exhausted policy releases the rest of its reservation.
    expect(payout?.amount).toBe('2400000000000')
    expect(hit?.pool.total_assets).toBe('1800000000000')
    expect(hit?.pool.locked_limit).toBe('0')
    expect(hit?.pool.utilization_bps).toBe(0)
    expect(hit?.pool.open_incidents).toBe(0)
    expect(hit?.pool.policies_in_force).toBe(0)
    // Exhausted, so `/pools/:protocol` no longer lists it — as the API filters.
    expect(hit?.policies).toEqual([])
    // Shares do not move on a payout: each is worth less now.
    expect(BigInt(hit?.pool.total_shares ?? 0)).toBeGreaterThan(BigInt(hit?.pool.total_assets ?? 0))
    // The other pools are untouched.
    expect(
      POOLS.pools
        .filter((p) => p.protocol !== incident.protocol)
        .every((p) => p.total_assets === p.total_shares),
    ).toBe(true)
  })
})
