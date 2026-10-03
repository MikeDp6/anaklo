import { describe, expect, it } from 'vitest'
import { CLIENT_IDS, liveCardJson } from './testFixtures'
import {
  ClientCardJson,
  ClientDetailsForm,
  NoteForm,
  STAFF_CONSENT_NOTICE_VERSION,
  toClientCard,
  toDetailsInput,
  toEraseResult,
  toSetConsentResult,
} from './schema'

describe('ClientCardJson (contract 1.8 §2.6: exactly its keys)', () => {
  it('parses a live card and maps it to the app shape', () => {
    const card = toClientCard(liveCardJson())
    expect(card.state).toBe('live')
    if (card.state !== 'live') return
    expect(card.details).toMatchObject({ fullName: 'Γιώργος Π.', phoneE164: '+306900000001' })
    expect(card.ring).toEqual({
      state: 'within',
      daysSinceLast: 10,
      intervalDays: 28,
      intervalWeeks: 4,
      fraction: 0.36,
      overdueDays: null,
      hintKey: 'nextVisit.vertical',
    })
    expect(card.history.map((item) => item.amountCents)).toEqual([1300, 1500])
    expect(card.consents.current.marketing_sms).toEqual({
      state: 'granted',
      recordId: CLIENT_IDS.grant,
    })
    expect(card.consents.records[0]).toMatchObject({ legalBasis: 'soft_opt_in', givenBy: 'client' })
    expect(card.can).toEqual({ erase: true, merge: true })
  })

  it('parses the merged and the erased states (the state, the id and one more key only)', () => {
    expect(
      toClientCard({
        state: 'merged',
        client_id: CLIENT_IDS.merged,
        merged_into_id: CLIENT_IDS.client,
      }),
    ).toEqual({ state: 'merged', clientId: CLIENT_IDS.merged, mergedIntoId: CLIENT_IDS.client })
    expect(
      toClientCard({
        state: 'erased',
        client_id: CLIENT_IDS.client,
        erased_at: '2026-10-03T09:00:00+00:00',
      }),
    ).toEqual({
      state: 'erased',
      clientId: CLIENT_IDS.client,
      erasedAt: '2026-10-03T09:00:00+00:00',
    })
  })

  it('rejects an unknown state', () => {
    expect(ClientCardJson.safeParse({ ...liveCardJson(), state: 'archived' }).success).toBe(false)
    expect(ClientCardJson.safeParse({ state: 'gone', client_id: CLIENT_IDS.client }).success).toBe(
      false,
    )
  })

  it('rejects an extra key, at the top and inside', () => {
    expect(ClientCardJson.safeParse(liveCardJson({ ltv_cents: 0 })).success).toBe(false)
    const card = liveCardJson()
    const details = { ...(card.details as object), memory_phase: 'regular' }
    expect(ClientCardJson.safeParse({ ...card, details }).success).toBe(false)
    expect(
      ClientCardJson.safeParse({
        state: 'erased',
        client_id: CLIENT_IDS.client,
        erased_at: '2026-10-03T09:00:00+00:00',
        full_name: '',
      }).success,
    ).toBe(false)
  })

  it('rejects a missing key and a wrong ring state', () => {
    const withoutCan: Record<string, unknown> = liveCardJson()
    delete withoutCan.can
    expect(ClientCardJson.safeParse(withoutCan).success).toBe(false)
    const ring = { ...(liveCardJson().ring as object), state: 'late' }
    expect(ClientCardJson.safeParse(liveCardJson({ ring })).success).toBe(false)
  })
})

describe('the write answers', () => {
  it('set_client_consent: the family state after the call', () => {
    expect(
      toSetConsentResult({
        client_id: CLIENT_IDS.client,
        purpose: 'marketing_sms',
        state: 'refused',
        changed: true,
        consent_id: null,
        withdrawn: 1,
      }),
    ).toEqual({
      clientId: CLIENT_IDS.client,
      purpose: 'marketing_sms',
      state: 'refused',
      changed: true,
      consentId: null,
      withdrawn: 1,
    })
  })

  it('erase_client: a committed retry answers erased: false, still parsed as a success', () => {
    const result = toEraseResult({
      client_id: CLIENT_IDS.client,
      erased: false,
      erased_at: '2026-10-03T09:00:00+00:00',
      erased_ids: [],
      appointments_kept: 0,
      notes_deleted: 0,
      consents_deleted: 0,
      messages_wiped: 0,
      otp_challenges_wiped: 0,
      devices_revoked: 0,
      tokens_revoked: 0,
      suppressed: 0,
    })
    expect(result).toMatchObject({ clientId: CLIENT_IDS.client, erased: false, erasedIds: [] })
  })
})

describe('STAFF_CONSENT_NOTICE_VERSION', () => {
  it('fits client_consents.policy_version (1–40 characters)', () => {
    expect(STAFF_CONSENT_NOTICE_VERSION.length).toBeGreaterThanOrEqual(1)
    expect(STAFF_CONSENT_NOTICE_VERSION.length).toBeLessThanOrEqual(40)
  })
})

describe('NoteForm', () => {
  it('needs text; spaces alone are not a note', () => {
    expect(NoteForm.safeParse({ body: 'Κοντά στο πλάι' }).success).toBe(true)
    const empty = NoteForm.safeParse({ body: '   \n ' })
    expect(empty.success).toBe(false)
    expect(empty.error?.issues[0]?.message).toBe('clients.notes.errors.required')
  })

  it('counts characters as char_length does: 2000 emoji fit, 2001 do not', () => {
    expect(NoteForm.safeParse({ body: '😀'.repeat(2000) }).success).toBe(true)
    const long = NoteForm.safeParse({ body: 'α'.repeat(2001) })
    expect(long.error?.issues[0]?.message).toBe('clients.notes.errors.tooLong')
  })
})

describe('ClientDetailsForm', () => {
  it('a Greek mobile in any common shape becomes E.164; empty = no mobile', () => {
    const values = { fullName: '  Γιώργος Π. ', phone: '6900 000 001', locale: 'el' as const }
    expect(ClientDetailsForm.safeParse(values).success).toBe(true)
    expect(toDetailsInput(values)).toEqual({
      fullName: 'Γιώργος Π.',
      phoneE164: '+306900000001',
      locale: 'el',
    })
    expect(toDetailsInput({ ...values, phone: ' ' }).phoneE164).toBeNull()
    expect(toDetailsInput({ ...values, phone: '+30 690 000 0001' }).phoneE164).toBe('+306900000001')
  })

  it('refuses an empty or too long name and a wrong phone, with i18n keys', () => {
    const issue = (values: unknown) =>
      ClientDetailsForm.safeParse(values).error?.issues.map((item) => item.message)
    expect(issue({ fullName: ' ', phone: '', locale: 'el' })).toEqual([
      'clients.edit.errors.nameRequired',
    ])
    expect(issue({ fullName: 'α'.repeat(121), phone: '', locale: 'el' })).toEqual([
      'clients.edit.errors.nameTooLong',
    ])
    expect(issue({ fullName: 'Γιώργος', phone: '12345', locale: 'el' })).toEqual([
      'clients.edit.errors.phoneInvalid',
    ])
    expect(ClientDetailsForm.safeParse({ fullName: 'Γ', phone: '', locale: 'de' }).success).toBe(
      false,
    )
  })
})
