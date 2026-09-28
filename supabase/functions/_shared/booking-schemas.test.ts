import { describe, expect, it } from 'vitest'
import { base64UrlLength, toBase64Url } from './base64url.ts'
import {
  BookRequest,
  BookResponse,
  ClientsRequest,
  ClientsResponse,
  ErrorBody,
  GRANT_LENGTH,
  isManageToken,
  isShortCode,
  MANAGE_ACTIONS,
  MANAGE_TOKEN_LENGTH,
  ManageRequest,
  ManageRescheduleResponse,
  ManageSlotsResponse,
  ManageViewResponse,
  MAX_CLIENT_CHOICES,
  PRIVACY_NOTICE_VERSION,
  PUBLIC_BOOKING_ACTIONS,
  PublicBookingRequest,
  StartResponse,
  TRUSTED_DEVICE_TOKEN_LENGTH,
  VerifyResponse,
} from './booking-schemas.ts'

const BUSINESS = '00000000-0000-4000-8000-000000000001'
const SERVICE = '00000000-0000-4000-8000-000000000301'
const STAFF = '00000000-0000-4000-8000-000000000101'
const CLIENT = '6f1c1c3e-2b8a-4f0e-9a51-0d8b1e0c7a11'
const CHALLENGE = 'b5e0f3a2-7c41-4d6b-8e2f-3a9c0d1e2f40'
const KEY = '2c9a8f71-5d3e-4b0a-9f6c-1e2d3c4b5a69'
// Postgres/PostgREST print timestamptz like this (UTC session), with or without microseconds.
const STARTS = '2026-10-06T07:00:00+00:00'
const ENDS = '2026-10-06T07:30:00+00:00'
const NOW_PRECISE = '2026-09-28T10:15:30.123456+00:00'

const GRANT = toBase64Url(new Uint8Array(32).fill(7))
const MANAGE_TOKEN = toBase64Url(new Uint8Array(16).fill(9))

const start = {
  action: 'start',
  business_id: BUSINESS,
  phone: '+306900000001',
  locale: 'el',
  service_ids: [SERVICE],
  staff_id: STAFF,
  starts_at: STARTS,
}

const book = {
  action: 'book',
  business_id: BUSINESS,
  idempotency_key: KEY,
  phone: '+306900000001',
  locale: 'el',
  service_ids: [SERVICE],
  staff_id: null,
  starts_at: STARTS,
  grant: GRANT,
  client: { kind: 'existing', client_id: CLIENT },
  marketing_box: 'unchecked',
}

describe('token and code sizes', () => {
  it('match the random byte counts of the SQL (≥ 128 bit, unpadded base64url)', () => {
    expect(GRANT_LENGTH).toBe(43)
    expect(TRUSTED_DEVICE_TOKEN_LENGTH).toBe(43)
    expect(MANAGE_TOKEN_LENGTH).toBe(22)
    expect(GRANT.length).toBe(base64UrlLength(32))
    expect(MANAGE_TOKEN.length).toBe(base64UrlLength(16))
  })

  it('recognises manage tokens and short codes for the routes', () => {
    expect(isManageToken(MANAGE_TOKEN)).toBe(true)
    expect(isManageToken(`${MANAGE_TOKEN}x`)).toBe(false)
    expect(isManageToken('abc+/defghijklmnopqrst')).toBe(false)
    expect(isManageToken(null)).toBe(false)
    expect(isShortCode('demo01')).toBe(true)
    expect(isShortCode('Demo01')).toBe(false)
    expect(isShortCode('demo0')).toBe(false)
    expect(isShortCode('demo-1')).toBe(false)
  })

  it('keeps the privacy notice version inside the client_consents CHECK (1–40 chars)', () => {
    expect(PRIVACY_NOTICE_VERSION.length).toBeGreaterThanOrEqual(1)
    expect(PRIVACY_NOTICE_VERSION.length).toBeLessThanOrEqual(40)
  })
})

describe('public-booking requests', () => {
  it('accept every action of the contract', () => {
    const bodies = [
      start,
      {
        action: 'verify',
        business_id: BUSINESS,
        phone: '+306900000001',
        challenge_id: CHALLENGE,
        code: '424242',
      },
      { action: 'clients', business_id: BUSINESS, phone: '+306900000001', grant: null },
      book,
      { action: 'forget', business_id: BUSINESS },
    ]
    for (const body of bodies) expect(PublicBookingRequest.safeParse(body).success).toBe(true)
    expect(bodies.map((body) => body.action)).toEqual([...PUBLIC_BOOKING_ACTIONS])
  })

  it('refuse unknown actions and unknown keys (strict)', () => {
    expect(PublicBookingRequest.safeParse({ ...start, action: 'book_now' }).success).toBe(false)
    expect(PublicBookingRequest.safeParse({ ...start, price_cents: 1 }).success).toBe(false)
    expect(PublicBookingRequest.safeParse({ ...book, verified_via: 'otp' }).success).toBe(false)
  })

  it('take one service per online booking (D9) and any staff as null', () => {
    expect(PublicBookingRequest.safeParse({ ...start, service_ids: [] }).success).toBe(false)
    expect(
      PublicBookingRequest.safeParse({ ...start, service_ids: [SERVICE, SERVICE] }).success,
    ).toBe(false)
    expect(PublicBookingRequest.safeParse({ ...start, staff_id: null }).success).toBe(true)
    expect(PublicBookingRequest.safeParse({ ...start, staff_id: undefined }).success).toBe(false)
  })

  it('need E.164 phones, instants with an offset and 6-digit codes', () => {
    expect(PublicBookingRequest.safeParse({ ...start, phone: '6900000001' }).success).toBe(false)
    expect(PublicBookingRequest.safeParse({ ...start, phone: '+44 7700 900123' }).success).toBe(
      false,
    )
    // Other countries pass the schema; the SQL refuses them for OTP (AN018).
    expect(PublicBookingRequest.safeParse({ ...start, phone: '+447700900123' }).success).toBe(true)
    expect(
      PublicBookingRequest.safeParse({ ...start, starts_at: '2026-10-06T07:00:00' }).success,
    ).toBe(false)
    expect(
      PublicBookingRequest.safeParse({ ...start, starts_at: '2026-10-06T10:00:00+03:00' }).success,
    ).toBe(true)
    const verify = {
      action: 'verify',
      business_id: BUSINESS,
      phone: '+306900000001',
      challenge_id: CHALLENGE,
    }
    for (const code of ['12345', '1234567', '12a456', ' 123456']) {
      expect(PublicBookingRequest.safeParse({ ...verify, code }).success).toBe(false)
    }
  })

  it('carry the grant only in its exact form, or null for the trusted device', () => {
    const clients = { action: 'clients', business_id: BUSINESS, phone: '+306900000001' }
    expect(ClientsRequest.safeParse({ ...clients, grant: GRANT }).success).toBe(true)
    expect(ClientsRequest.safeParse({ ...clients, grant: null }).success).toBe(true)
    expect(ClientsRequest.safeParse(clients).success).toBe(false)
    expect(ClientsRequest.safeParse({ ...clients, grant: GRANT.slice(1) }).success).toBe(false)
  })

  it('book an existing client or a new one, never both', () => {
    const newClient = { ...book, client: { kind: 'new', full_name: '  Γιώργος Παπαδόπουλος ' } }
    const parsed = BookRequest.safeParse(newClient)
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.client.kind === 'new') {
      expect(parsed.data.client.full_name).toBe('Γιώργος Παπαδόπουλος')
    }
    expect(
      BookRequest.safeParse({ ...book, client: { kind: 'new', full_name: '   ' } }).success,
    ).toBe(false)
    expect(
      BookRequest.safeParse({ ...book, client: { kind: 'new', full_name: 'x'.repeat(121) } })
        .success,
    ).toBe(false)
    expect(
      BookRequest.safeParse({
        ...book,
        client: { kind: 'existing', client_id: CLIENT, full_name: 'Γιώργος' },
      }).success,
    ).toBe(false)
  })

  it('need the idempotency key and a known marketing box state', () => {
    expect(BookRequest.safeParse({ ...book, idempotency_key: undefined }).success).toBe(false)
    expect(BookRequest.safeParse({ ...book, idempotency_key: 'retry-1' }).success).toBe(false)
    for (const state of ['not_shown', 'unchecked', 'checked']) {
      expect(BookRequest.safeParse({ ...book, marketing_box: state }).success).toBe(true)
    }
    expect(BookRequest.safeParse({ ...book, marketing_box: true }).success).toBe(false)
  })
})

describe('public-booking responses', () => {
  it('start: the same otp_sent shape for any number, or trusted with clients', () => {
    const sent = {
      result: 'otp_sent',
      challenge_id: CHALLENGE,
      expires_at: NOW_PRECISE,
      resend_at: NOW_PRECISE,
    }
    expect(StartResponse.safeParse(sent).success).toBe(true)
    expect(
      StartResponse.safeParse({
        result: 'trusted',
        clients: [{ id: CLIENT, first_name: 'Γιώργος' }],
      }).success,
    ).toBe(true)
    expect(StartResponse.safeParse({ ...sent, result: 'sent' }).success).toBe(false)
  })

  it('verify and clients return only first names, at most 20', () => {
    const clients = [{ id: CLIENT, first_name: 'Γιώργος' }]
    expect(
      VerifyResponse.safeParse({ grant: GRANT, grant_expires_at: NOW_PRECISE, clients }).success,
    ).toBe(true)
    expect(ClientsResponse.safeParse({ verified_via: 'trusted_device', clients: [] }).success).toBe(
      true,
    )
    expect(ClientsResponse.safeParse({ verified_via: 'sms', clients }).success).toBe(false)
    const tooMany = Array.from({ length: MAX_CLIENT_CHOICES + 1 }, () => clients[0])
    expect(ClientsResponse.safeParse({ verified_via: 'otp', clients: tooMany }).success).toBe(false)
  })

  it('book returns the appointment, a manage token and the next-visit hint', () => {
    const response = {
      appointment: {
        id: CLIENT,
        staff_id: STAFF,
        starts_at: STARTS,
        ends_at: ENDS,
        total_cents: 1300,
      },
      manage_token: MANAGE_TOKEN,
      replayed: false,
      verified_via: 'otp',
      next_visit_hint: { key: 'nextVisit.vertical', weeks: 4 },
    }
    expect(BookResponse.safeParse(response).success).toBe(true)
    expect(BookResponse.safeParse({ ...response, next_visit_hint: null }).success).toBe(true)
    expect(
      BookResponse.safeParse({ ...response, next_visit_hint: { key: 'nextVisit.other', weeks: 4 } })
        .success,
    ).toBe(false)
    expect(
      BookResponse.safeParse({
        ...response,
        next_visit_hint: { key: 'nextVisit.business', weeks: 0 },
      }).success,
    ).toBe(false)
    expect(BookResponse.safeParse({ ...response, manage_token: GRANT }).success).toBe(false)
  })

  it('tolerate extra response fields (newer server, older page)', () => {
    expect(
      StartResponse.safeParse({ result: 'trusted', clients: [], debug_hint: 'ignored' }).success,
    ).toBe(true)
  })
})

describe('manage', () => {
  it('accepts exactly view, slots, cancel and reschedule, all with a token', () => {
    const bodies = [
      { action: 'view', token: MANAGE_TOKEN },
      { action: 'slots', token: MANAGE_TOKEN, from: '2026-10-06', to: '2026-10-12' },
      { action: 'cancel', token: MANAGE_TOKEN },
      { action: 'reschedule', token: MANAGE_TOKEN, starts_at: STARTS },
    ]
    for (const body of bodies) expect(ManageRequest.safeParse(body).success).toBe(true)
    expect(bodies.map((body) => body.action)).toEqual([...MANAGE_ACTIONS])
    expect(ManageRequest.safeParse({ action: 'view' }).success).toBe(false)
    expect(ManageRequest.safeParse({ action: 'view', token: GRANT }).success).toBe(false)
    expect(ManageRequest.safeParse({ action: 'delete', token: MANAGE_TOKEN }).success).toBe(false)
    expect(
      ManageRequest.safeParse({
        action: 'slots',
        token: MANAGE_TOKEN,
        from: '06/10/2026',
        to: '2026-10-12',
      }).success,
    ).toBe(false)
  })

  it('parses the view, slots and reschedule answers as the RPCs print them', () => {
    const view = {
      business: {
        id: BUSINESS,
        slug: 'demo-barber',
        name: 'Demo Barber',
        timezone: 'Europe/Athens',
        locale: 'el',
        currency: 'EUR',
        phone_e164: '+302610000000',
        address: null,
        maps_url: null,
        theme: { primary: '#C8A15A' },
      },
      appointment: {
        id: CLIENT,
        status: 'booked',
        starts_at: STARTS,
        ends_at: ENDS,
        total_cents: 1300,
        staff: { id: STAFF, display_name: 'Νίκος' },
        services: [{ id: SERVICE, name: 'Κούρεμα', duration_min: 30, price_cents: 1300 }],
      },
      change_until: '2026-10-06T05:00:00+00:00',
      can_cancel: true,
      can_reschedule: true,
    }
    expect(ManageViewResponse.safeParse(view).success).toBe(true)
    expect(
      ManageViewResponse.safeParse({
        ...view,
        appointment: { ...view.appointment, status: 'moved' },
      }).success,
    ).toBe(false)
    expect(
      ManageSlotsResponse.safeParse({
        slots: [{ starts_at: STARTS, local_date: '2026-10-06', local_time: '10:00:00' }],
      }).success,
    ).toBe(true)
    expect(
      ManageRescheduleResponse.safeParse({
        appointment: { id: CLIENT, staff_id: STAFF, starts_at: STARTS, ends_at: ENDS },
      }).success,
    ).toBe(true)
  })
})

describe('errors', () => {
  it('have one shape for every function and the proxy', () => {
    expect(
      ErrorBody.safeParse({ error: { code: 'AN013', message: 'Rate limited.' } }).success,
    ).toBe(true)
    expect(ErrorBody.safeParse({ error: 'AN013' }).success).toBe(false)
  })
})
