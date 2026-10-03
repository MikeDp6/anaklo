import { describe, expect, it } from 'vitest'
import { consentView } from './consentView'
import type { ConsentRecord, CurrentConsent } from './schema'
import { CLIENT_IDS } from './testFixtures'

const NONE: CurrentConsent = { state: 'none', recordId: null }

function current(marketing: CurrentConsent) {
  return {
    marketing_sms: marketing,
    marketing_email: NONE,
    photos_record: NONE,
    photos_publish: NONE,
  }
}

function record(patch: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: CLIENT_IDS.grant,
    clientId: CLIENT_IDS.client,
    purpose: 'marketing_sms',
    legalBasis: 'consent',
    granted: true,
    source: 'staff_ui',
    givenBy: 'client',
    policyVersion: 'staff-consent-2026-10-03',
    createdAt: '2026-09-01T10:00:00+00:00',
    withdrawnAt: null,
    ...patch,
  }
}

describe('consentView (contract 1.8 §4.6): the server state, told by the record it named', () => {
  it('none', () => {
    expect(consentView(current(NONE), [])).toEqual({ kind: 'none' })
  })

  it('granted on the booking form (soft opt-in)', () => {
    const grant = record({ legalBasis: 'soft_opt_in', source: 'booking_form' })
    expect(consentView(current({ state: 'granted', recordId: grant.id }), [grant])).toEqual({
      kind: 'bookingForm',
      at: grant.createdAt,
    })
  })

  it('granted in the shop, by the client or by a guardian', () => {
    const grant = record({})
    expect(consentView(current({ state: 'granted', recordId: grant.id }), [grant])).toEqual({
      kind: 'inShop',
      at: grant.createdAt,
      guardian: false,
    })
    const byGuardian = record({ givenBy: 'guardian' })
    expect(
      consentView(current({ state: 'granted', recordId: byGuardian.id }), [byGuardian]),
    ).toEqual({ kind: 'inShop', at: byGuardian.createdAt, guardian: true })
  })

  it('refused: the refusal named by the server, not an older grant of the family', () => {
    const olderGrant = record({ createdAt: '2026-08-01T10:00:00+00:00' })
    const refusal = record({
      id: CLIENT_IDS.refusal,
      granted: false,
      legalBasis: 'soft_opt_in',
      source: 'booking_form',
      createdAt: '2026-09-15T10:00:00+00:00',
    })
    expect(
      consentView(current({ state: 'refused', recordId: refusal.id }), [refusal, olderGrant]),
    ).toEqual({ kind: 'refused', at: refusal.createdAt })
  })

  it('a state whose record is missing still says the state, without a date', () => {
    expect(consentView(current({ state: 'refused', recordId: CLIENT_IDS.refusal }), [])).toEqual({
      kind: 'refused',
      at: null,
    })
  })

  it('looks only at the purpose asked for', () => {
    const photos = record({ purpose: 'photos_record' })
    const state = {
      ...current(NONE),
      photos_record: { state: 'granted' as const, recordId: photos.id },
    }
    expect(consentView(state, [photos])).toEqual({ kind: 'none' })
    expect(consentView(state, [photos], 'photos_record')).toMatchObject({ kind: 'inShop' })
  })
})
