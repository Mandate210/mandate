import { describe, expect, it } from 'vitest'
import { ACCOUNT_DISCRIMINATOR_LENGTH, accountFieldOffset, openIncidentsFilter } from './filters'

describe('account field offsets', () => {
  // The number the sweeper's filter rides on, written out by hand exactly once — here,
  // where a mismatch fails a test instead of returning an empty page of incidents.
  it('puts Incident.status where the fields before it end', () => {
    const before =
      32 + // policy
      64 + // trigger_sig
      32 + // opener
      8 + // bond
      8 + // opened_at
      8 + // opened_epoch
      8 + // deadline
      2 + // set_size
      2 + // votes_unauthorized
      2 // votes_authorized

    expect(accountFieldOffset('Incident', 'status')).toBe(ACCOUNT_DISCRIMINATOR_LENGTH + before)
  })

  it('starts the first field right after the discriminator', () => {
    expect(accountFieldOffset('Incident', 'policy')).toBe(ACCOUNT_DISCRIMINATOR_LENGTH)
  })

  it('refuses a field or an account it does not know', () => {
    expect(() => accountFieldOffset('Incident', 'nonesuch')).toThrow(/no field/)
    expect(() => accountFieldOffset('Nonesuch', 'status')).toThrow(/no such account/)
  })
})

describe('the open-incidents filter', () => {
  it('matches the first variant of IncidentStatus', () => {
    const [filter] = openIncidentsFilter()

    expect(filter).toEqual({
      memcmp: { offset: accountFieldOffset('Incident', 'status'), bytes: '1' },
    })
  })
})
