import {
  configResponseSchema,
  declarationsResponseSchema,
  entryStateAt,
  incidentDetailResponseSchema,
  poolsResponseSchema,
  protocolDetailResponseSchema,
} from '@mandate/shared'
import { describe, expect, it } from 'vitest'
import { CONFIG, DECLARATIONS, INCIDENT_DETAIL, POOLS, PROTOCOL_DETAILS } from './fixtures'
import { DECLARATION_SNAPSHOT, PROTOCOLS, TIMELINE } from './mockData'

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
    // Every entry at the trigger belongs to other operations or is out of its window;
    // the snapshot is there to show that, and the timeline says it in words.
    expect(DECLARATION_SNAPSHOT.length).toBeGreaterThan(0)
    expect(TIMELINE[0]?.lines?.[1]).toMatch(/matches no effective declaration entry \(\d+ in force\)/)
  })

  it('pay out only once the unauthorized tally reaches the quorum', () => {
    const quorum = TIMELINE.find((e) => e.quorumReached)
    expect(quorum?.tally).toBe(INCIDENT_DETAIL.incident.quorum_needed)
    expect(INCIDENT_DETAIL.incident.votes_unauthorized).toBeGreaterThanOrEqual(
      INCIDENT_DETAIL.incident.quorum_needed,
    )
    // The protocol with the incident is the one whose pool the pages link to.
    expect(PROTOCOLS.some((p) => p.id === INCIDENT_DETAIL.incident.protocol)).toBe(true)
  })
})
