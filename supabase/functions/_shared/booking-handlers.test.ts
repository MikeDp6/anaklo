// @vitest-environment node
// Request/Response/Headers from Node (undici), the same Fetch API the Deno runtime provides.
//
// `public-booking` and `manage` end to end against an in-memory stand-in of the 0005 RPCs
// (contract 1.3 §2.6), with the real fake SMS adapter. The SQL itself is tested by pgTAP
// (10_public_booking); this file tests what the functions do with it.
import { describe, expect, it } from 'vitest'
import { isBase64UrlOfLength, toBase64Url } from './base64url.ts'
import type { BookingConfigEnv } from './booking-config.ts'
import type { LogValue, Rpc, RpcResult } from './booking-rpc.ts'
import { buildBookingRuntime, type BookingRuntime } from './booking-runtime.ts'
import {
  BookResponse,
  ClientsResponse,
  ErrorBody,
  isManageToken,
  ForgetResponse,
  ManageCancelResponse,
  ManageRescheduleResponse,
  ManageSlotsResponse,
  ManageViewResponse,
  PRIVACY_NOTICE_VERSION,
  StartResponse,
  VerifyResponse,
} from './booking-schemas.ts'
import { PROXY_HEADERS } from './proxy-contract.ts'
import { handleManage } from './manage-handler.ts'
import { handlePublicBooking } from './public-booking-handler.ts'

const SECRET = 'local-dev-proxy-secret-change-me'
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const OTHER_BUSINESS = '00000000-0000-4000-8000-000000000002'
const SERVICE = '00000000-0000-4000-8000-000000000301'
const STAFF = '00000000-0000-4000-8000-000000000101'
const STARTS = '2026-10-06T07:00:00+00:00'
const ENDS = '2026-10-06T07:30:00+00:00'
const MOVED = '2026-10-07T08:00:00+00:00'
const MOVED_ENDS = '2026-10-07T08:30:00+00:00'
const NOW = '2026-09-28T10:00:00+00:00'
const LATER = '2026-09-28T10:05:00+00:00'
const IP = '203.0.113.7'

/** Seed: two clients share this phone (e2e «κοινό κινητό»). A test number. */
const KNOWN = '+306900000001'
/** A test number without a client. */
const UNKNOWN = '+306900000999'
/** Not a test number: gets a random code, read from the fake adapter's local log. */
const REAL = '+306912345678'
const TEST_CODE = '424242'

const LOCAL_ENV: BookingConfigEnv = {
  ANAKLO_ENV: 'local',
  SITE_HOST: 'localhost:5173',
  SMS_PROVIDER: 'fake',
  OTP_TEST_NUMBERS: `${KNOWN},${UNKNOWN}`,
  OTP_TEST_CODE: TEST_CODE,
  SMS_ALLOWED_RECIPIENTS: '',
}

const newToken = (bytes: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
const ok = (data: unknown): RpcResult => ({ data, error: null })
const raise = (code: string, hint: string): RpcResult => ({
  data: null,
  error: { code: 'P0001', message: code, hint },
})

type Args = Readonly<Record<string, unknown>>
type Challenge = {
  business: string
  phone: string
  code: string
  attempts: number
  verified: boolean
  grant: string | null
  grantAppointment: string | null
}
type Appointment = {
  id: string
  business: string
  staffId: string
  startsAt: string
  endsAt: string
  status: 'booked' | 'cancelled'
  key: string
  payload: string
  verifiedVia: 'otp' | 'trusted_device'
}
type Message = {
  id: string
  template: string
  to: string
  locale: 'el' | 'en'
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled'
  appointment: string | null
}

/**
 * The 0005 RPCs as the contract describes them, in memory: enough behaviour to test what the
 * functions do (proof precedence, grant consumption, idempotent replay, tokens per message).
 */
class FakeDb {
  readonly calls: Array<{ fn: string; args: Args }> = []
  readonly clients = new Map<string, Array<{ id: string; first_name: string }>>([
    [
      KNOWN,
      [
        { id: crypto.randomUUID(), first_name: 'Γιώργος' },
        { id: crypto.randomUUID(), first_name: 'Μάριος' },
      ],
    ],
  ])
  readonly challenges = new Map<string, Challenge>()
  readonly devices = new Map<string, { business: string; phone: string; revoked: boolean }>()
  readonly appointments = new Map<string, Appointment>()
  readonly tokens = new Map<string, { appointment: string; revoked: boolean }>()
  readonly messages = new Map<string, Message>()
  smsEnabled = true
  /** Replaces one RPC's answer (errors, malformed results). */
  readonly overrides = new Map<string, (args: Args) => RpcResult>()

  readonly rpc: Rpc = (fn, args) => {
    this.calls.push({ fn, args })
    const override = this.overrides.get(fn)
    if (override) return Promise.resolve(override(args))
    const handler = this.handlers[fn]
    if (!handler) return Promise.reject(new Error(`unexpected rpc ${fn}`))
    return Promise.resolve(handler(args))
  }

  called(fn: string): number {
    return this.calls.filter((call) => call.fn === fn).length
  }

  argsOf(fn: string): Args | undefined {
    return this.calls.findLast((call) => call.fn === fn)?.args
  }

  private queue(template: string, to: string, locale: 'el' | 'en', appointment: string | null) {
    const id = crypto.randomUUID()
    this.messages.set(id, { id, template, to, locale, status: 'queued', appointment })
    return id
  }

  private queuedOf(appointment: string): string[] {
    return [...this.messages.values()]
      .filter((m) => m.appointment === appointment && m.status === 'queued')
      .map((m) => m.id)
  }

  private liveGrant(business: string, phone: string, grant: unknown): Challenge | null {
    if (typeof grant !== 'string') return null
    for (const challenge of this.challenges.values()) {
      if (
        challenge.grant === grant &&
        challenge.business === business &&
        challenge.phone === phone &&
        challenge.grantAppointment === null
      )
        return challenge
    }
    return null
  }

  private validDevice(business: string, phone: string, token: unknown): boolean {
    if (typeof token !== 'string') return false
    const device = this.devices.get(token)
    return (
      device !== undefined &&
      !device.revoked &&
      device.business === business &&
      device.phone === phone
    )
  }

  private issueToken(appointment: string): string {
    const token = newToken(16)
    this.tokens.set(token, { appointment, revoked: false })
    return token
  }

  private resolve(token: unknown): Appointment | null {
    const entry = typeof token === 'string' ? this.tokens.get(token) : undefined
    if (!entry || entry.revoked) return null
    return this.appointments.get(entry.appointment) ?? null
  }

  private readonly handlers: Record<string, (args: Args) => RpcResult> = {
    otp_start: (args) => {
      const phone = String(args.p_phone)
      if (!/^\+3069\d{8}$/.test(phone)) return raise('AN018', 'phone_not_supported')
      const id = crypto.randomUUID()
      const code = typeof args.p_code === 'string' ? args.p_code : '135790'
      this.challenges.set(id, {
        business: String(args.p_business_id),
        phone,
        code,
        attempts: 0,
        verified: false,
        grant: null,
        grantAppointment: null,
      })
      const messageId = this.queue('otp', phone, args.p_locale === 'en' ? 'en' : 'el', null)
      return ok({
        challenge_id: id,
        message_id: messageId,
        code,
        expires_at: LATER,
        resend_at: NOW,
      })
    },

    otp_verify: (args) => {
      const challenge = this.challenges.get(String(args.p_challenge_id))
      if (
        !challenge ||
        challenge.verified ||
        challenge.business !== args.p_business_id ||
        challenge.phone !== args.p_phone
      )
        return ok({ result: 'expired' })
      if (challenge.attempts >= 5) return ok({ result: 'locked' })
      if (challenge.code !== args.p_code) {
        challenge.attempts += 1
        return challenge.attempts >= 5
          ? ok({ result: 'locked' })
          : ok({ result: 'invalid', attempts_left: 5 - challenge.attempts })
      }
      challenge.verified = true
      challenge.grant = newToken(32)
      const td = newToken(32)
      this.devices.set(td, { business: challenge.business, phone: challenge.phone, revoked: false })
      return ok({
        result: 'verified',
        grant: challenge.grant,
        grant_expires_at: LATER,
        trusted_device_token: td,
      })
    },

    clients_for_phone: (args) => {
      const business = String(args.p_business_id)
      const phone = String(args.p_phone)
      const via = this.liveGrant(business, phone, args.p_grant)
        ? 'otp'
        : this.validDevice(business, phone, args.p_trusted_device_token)
          ? 'trusted_device'
          : null
      if (via === null) return raise('AN014', 'verification_required')
      return ok({
        verified_via: via,
        clients: business === BUSINESS ? (this.clients.get(phone) ?? []) : [],
      })
    },

    book_appointment: (args) => {
      const business = String(args.p_business_id)
      const phone = String(args.p_phone)
      const key = String(args.p_idempotency_key)
      const payload = JSON.stringify([
        args.p_service_ids,
        args.p_staff_id,
        args.p_starts_at,
        phone,
        args.p_client_id,
        args.p_new_client,
      ])
      const existing = [...this.appointments.values()].find(
        (a) => a.business === business && a.key === key,
      )
      if (existing) {
        const usedGrant = [...this.challenges.values()].some(
          (c) => c.grant === args.p_grant && c.grantAppointment === existing.id,
        )
        const proof =
          usedGrant ||
          this.liveGrant(business, phone, args.p_grant) !== null ||
          this.validDevice(business, phone, args.p_trusted_device_token)
        if (!proof) return raise('AN014', 'verification_required')
        if (existing.payload !== payload) return raise('AN004', 'idempotency_conflict')
        return ok(this.bookResult(existing, true))
      }

      const grant = this.liveGrant(business, phone, args.p_grant)
      const via = grant
        ? 'otp'
        : this.validDevice(business, phone, args.p_trusted_device_token)
          ? 'trusted_device'
          : null
      if (via === null) return raise('AN014', 'verification_required')
      const taken = [...this.appointments.values()].some(
        (a) => a.status === 'booked' && a.staffId === STAFF && a.startsAt === args.p_starts_at,
      )
      if (taken) return raise('AN001', 'slot_taken')

      const appointment: Appointment = {
        id: crypto.randomUUID(),
        business,
        staffId: STAFF,
        startsAt: String(args.p_starts_at),
        endsAt: ENDS,
        status: 'booked',
        key,
        payload,
        verifiedVia: via,
      }
      this.appointments.set(appointment.id, appointment)
      if (grant) grant.grantAppointment = appointment.id
      this.queue('booking_confirmed', phone, 'el', appointment.id)
      return ok(this.bookResult(appointment, false))
    },

    trusted_device_revoke: (args) => {
      const device = this.devices.get(String(args.p_trusted_device_token))
      if (device && device.business === args.p_business_id) device.revoked = true
      return ok(null)
    },

    manage_view: (args) => {
      const appointment = this.resolve(args.p_token)
      if (!appointment) return raise('AN015', 'manage_token_invalid')
      return ok({
        business: {
          id: appointment.business,
          slug: 'demo-barber',
          name: 'Κουρείο Demo',
          timezone: 'Europe/Athens',
          locale: 'el',
          currency: 'EUR',
          phone_e164: '+302101234567',
          address: null,
          maps_url: null,
          theme: {},
          internal_note: 'must not leave the function',
        },
        appointment: {
          id: appointment.id,
          status: appointment.status,
          starts_at: appointment.startsAt,
          ends_at: appointment.endsAt,
          total_cents: 1300,
          staff: { id: appointment.staffId, display_name: 'Νίκος' },
          services: [{ id: SERVICE, name: 'Κούρεμα', duration_min: 30, price_cents: 1300 }],
        },
        change_until: appointment.startsAt,
        can_cancel: appointment.status === 'booked',
        can_reschedule: appointment.status === 'booked',
      })
    },

    manage_slots: (args) => {
      if (!this.resolve(args.p_token)) return raise('AN015', 'manage_token_invalid')
      return ok([{ starts_at: MOVED, local_date: '2026-10-07', local_time: '11:00:00' }])
    },

    manage_cancel: (args) => {
      const appointment = this.resolve(args.p_token)
      if (!appointment) return raise('AN015', 'manage_token_invalid')
      if (appointment.status !== 'booked') return raise('AN020', 'not_modifiable')
      appointment.status = 'cancelled'
      for (const entry of this.tokens.values()) {
        if (entry.appointment === appointment.id) entry.revoked = true
      }
      for (const id of this.queuedOf(appointment.id)) {
        const message = this.messages.get(id)
        if (message) message.status = 'cancelled'
      }
      this.queue('cancelled_by_client', KNOWN, 'el', appointment.id)
      return ok({
        appointment_id: appointment.id,
        status: 'cancelled',
        message_ids: this.queuedOf(appointment.id),
      })
    },

    manage_reschedule: (args) => {
      const appointment = this.resolve(args.p_token)
      if (!appointment) return raise('AN015', 'manage_token_invalid')
      appointment.startsAt = String(args.p_new_starts_at)
      appointment.endsAt = MOVED_ENDS
      this.queue('rescheduled_by_client', KNOWN, 'el', appointment.id)
      return ok({
        appointment_id: appointment.id,
        staff_id: appointment.staffId,
        starts_at: appointment.startsAt,
        ends_at: appointment.endsAt,
        message_ids: this.queuedOf(appointment.id),
      })
    },

    claim_messages: (args) => {
      if (!this.smsEnabled) return ok([])
      const ids = args.p_ids as string[]
      const rows = []
      for (const id of ids) {
        const message = this.messages.get(id)
        if (!message || message.status !== 'queued') continue
        message.status = 'sending'
        const appointment = message.appointment ? this.appointments.get(message.appointment) : null
        const managed = ['booking_confirmed', 'reminder', 'rescheduled_by_client']
        rows.push({
          id,
          lease_id: crypto.randomUUID(),
          to_e164: message.to,
          locale: message.locale,
          template: message.template,
          category: message.template === 'otp' ? 'otp' : 'transactional',
          business_name: 'Κουρείο Demo',
          short_code: 'demo01',
          timezone: 'Europe/Athens',
          starts_at: appointment?.startsAt ?? null,
          staff_name: appointment ? 'Νίκος' : null,
          manage_token:
            appointment && managed.includes(message.template)
              ? this.issueToken(appointment.id)
              : null,
        })
      }
      return ok(rows)
    },

    record_send_result: (args) => {
      const message = this.messages.get(String(args.p_id))
      if (!message || message.status !== 'sending') return ok(false)
      message.status =
        args.p_outcome === 'sent' ? 'sent' : args.p_outcome === 'failed' ? 'failed' : 'cancelled'
      return ok(true)
    },
  }

  private bookResult(appointment: Appointment, replayed: boolean) {
    return {
      appointment_id: appointment.id,
      staff_id: appointment.staffId,
      starts_at: appointment.startsAt,
      ends_at: appointment.endsAt,
      total_cents: 1300,
      replayed,
      verified_via: appointment.verifiedVia,
      manage_token: this.issueToken(appointment.id),
      message_ids: this.queuedOf(appointment.id),
      next_visit_hint: { key: 'nextVisit.vertical', weeks: 4 },
    }
  }
}

type Harness = {
  db: FakeDb
  runtime: BookingRuntime
  /** Every SMS text the fake adapter "sent" (its local log). */
  sms: string[]
  logs: Array<{ event: string; fields: Readonly<Record<string, LogValue>> }>
}

function harness(env: BookingConfigEnv = LOCAL_ENV): Harness {
  const db = new FakeDb()
  const sms: string[] = []
  const logs: Harness['logs'] = []
  const runtime = buildBookingRuntime(
    {
      PROXY_SECRET: SECRET,
      SUPABASE_URL: 'http://kong:8000',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
      ...env,
    },
    {
      createRpc: () => db.rpc,
      log: (event, fields) => logs.push({ event, fields }),
      providerLog: (line) => sms.push(line),
    },
  )
  return { db, runtime, sms, logs }
}

function request(
  fn: 'public-booking' | 'manage',
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST',
): Request {
  return new Request(`http://localhost/functions/v1/${fn}`, {
    method,
    headers: {
      [PROXY_HEADERS.secret]: SECRET,
      [PROXY_HEADERS.clientIp]: IP,
      [PROXY_HEADERS.business]: BUSINESS,
      'content-type': 'application/json',
      ...headers,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
}

async function booking(h: Harness, body: unknown, headers: Record<string, string> = {}) {
  const response = await handlePublicBooking(request('public-booking', body, headers), h.runtime)
  return { response, body: (await response.json()) as unknown }
}

async function manage(h: Harness, body: unknown) {
  const response = await handleManage(request('manage', body), h.runtime)
  return { response, body: (await response.json()) as unknown }
}

function errorCode(body: unknown): string | undefined {
  const parsed = ErrorBody.safeParse(body)
  return parsed.success ? parsed.data.error.code : undefined
}

function startBody(phone: string) {
  return {
    action: 'start',
    business_id: BUSINESS,
    phone,
    locale: 'el',
    service_ids: [SERVICE],
    staff_id: STAFF,
    starts_at: STARTS,
  }
}

function bookBody(phone: string, grant: string | null, key: string = crypto.randomUUID()) {
  return {
    action: 'book',
    business_id: BUSINESS,
    idempotency_key: key,
    phone,
    locale: 'el',
    service_ids: [SERVICE],
    staff_id: STAFF,
    starts_at: STARTS,
    grant,
    client: { kind: 'new', full_name: '  Νέος Πελάτης ' },
    marketing_box: 'unchecked',
  }
}

/** start → the SMS code (fixed for test numbers) → verify. */
async function verified(h: Harness, phone: string) {
  const started = await booking(h, startBody(phone))
  const start = StartResponse.parse(started.body)
  if (start.result !== 'otp_sent') throw new Error('expected otp_sent')
  const code = phone === REAL ? /^(\d{6}) /m.exec(h.sms.at(-1) ?? '')?.[1] : TEST_CODE
  const result = await booking(h, {
    action: 'verify',
    business_id: BUSINESS,
    phone,
    challenge_id: start.challenge_id,
    code,
  })
  return {
    ...VerifyResponse.parse(result.body),
    td: result.response.headers.get(PROXY_HEADERS.setTrustedDevice) ?? '',
  }
}

/** The manage link of the latest SMS, as the phone would receive it. */
function lastManageToken(sms: string[]): string {
  const token = /localhost:5173\/m\/([\w-]{22})/.exec(sms.at(-1) ?? '')?.[1]
  if (!token) throw new Error('no manage link in the last SMS')
  return token
}

describe('public-booking: before any action', () => {
  it('refuses requests that did not come through the proxy', async () => {
    const h = harness()
    const response = await handlePublicBooking(
      request('public-booking', startBody(KNOWN), { [PROXY_HEADERS.secret]: 'wrong' }),
      h.runtime,
    )
    expect(response.status).toBe(403)
    expect(h.db.calls).toEqual([])
  })

  it('answers 405 to anything but POST', async () => {
    const h = harness()
    const response = await handlePublicBooking(
      request('public-booking', null, {}, 'GET'),
      h.runtime,
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('POST')
  })

  it('answers 500 not_configured on every request when the configuration is refused', async () => {
    // Test numbers with ANAKLO_ENV unset = prod: refused at start-up.
    const h = harness({ ...LOCAL_ENV, ANAKLO_ENV: undefined })
    const { response, body } = await booking(h, startBody(KNOWN))
    expect(response.status).toBe(500)
    expect(errorCode(body)).toBe('not_configured')
    expect(h.db.calls).toEqual([])
    const problems = h.logs.find((line) => line.event === 'not_configured')?.fields.problems
    expect(problems).toContain(
      'OTP_TEST_NUMBERS / OTP_TEST_CODE: refused when ANAKLO_ENV is prod (or unset)',
    )
  })

  it('refuses a body outside the schema with 400 invalid_body', async () => {
    const h = harness()
    const { response, body } = await booking(h, { ...startBody(KNOWN), verified_via: 'otp' })
    expect(response.status).toBe(400)
    expect(errorCode(body)).toBe('invalid_body')
  })

  it('needs x-anaklo-business equal to the body business (the cookie was chosen by it)', async () => {
    const h = harness()
    for (const declared of [OTHER_BUSINESS, 'not-a-uuid', '']) {
      const { response, body } = await booking(h, startBody(KNOWN), {
        [PROXY_HEADERS.business]: declared,
      })
      expect(response.status).toBe(400)
      expect(errorCode(body)).toBe('business_mismatch')
    }
    expect(h.db.calls).toEqual([])
    const upper = await booking(h, startBody(KNOWN), {
      [PROXY_HEADERS.business]: BUSINESS.toUpperCase(),
    })
    expect(upper.response.status).toBe(200)
  })
})

describe('public-booking: start', () => {
  it('answers a known and an unknown number identically, without looking at clients', async () => {
    const results = []
    for (const phone of [KNOWN, UNKNOWN]) {
      const h = harness()
      const { response, body } = await booking(h, startBody(phone))
      results.push({
        status: response.status,
        headers: [...response.headers.keys()].sort(),
        keys: Object.keys(body as object).sort(),
        result: StartResponse.parse(body).result,
        calls: h.db.calls.map((call) => call.fn),
      })
      expect(h.db.argsOf('otp_start')).toMatchObject({
        p_business_id: BUSINESS,
        p_phone: phone,
        p_ip: IP,
        p_code: TEST_CODE,
      })
      expect(h.sms[0]).toContain(`${TEST_CODE} EINAI O KΩΔIKOΣ ΣOY`)
      expect(h.sms[0]).toContain(`@localhost #${TEST_CODE}`)
    }
    expect(results[0]).toEqual(results[1])
    expect(results[0]?.result).toBe('otp_sent')
    expect(results[0]?.calls).toEqual(['otp_start', 'claim_messages', 'record_send_result'])
  })

  it('lets SQL draw the code for a number that is not a test number', async () => {
    const h = harness()
    const { response } = await booking(h, startBody(REAL))
    expect(response.status).toBe(200)
    expect(h.db.argsOf('otp_start')?.p_code).toBeNull()
    expect(h.sms[0]).toContain('+30691****678')
  })

  it('still answers otp_sent for a recipient outside SMS_ALLOWED_RECIPIENTS (nothing is sent)', async () => {
    const h = harness({ ...LOCAL_ENV, SMS_ALLOWED_RECIPIENTS: '+306900000002' })
    const { response, body } = await booking(h, startBody(UNKNOWN))
    expect(response.status).toBe(200)
    expect(StartResponse.parse(body).result).toBe('otp_sent')
    expect(h.sms).toEqual([])
    expect(h.db.argsOf('record_send_result')).toMatchObject({
      p_outcome: 'rejected',
      p_error: 'recipient_not_allowed',
    })
  })

  it('answers AN017 (503) when the OTP could not be sent, so the page shows the shop phone', async () => {
    const h = harness()
    h.db.smsEnabled = false
    const { response, body } = await booking(h, startBody(KNOWN))
    expect(response.status).toBe(503)
    expect(errorCode(body)).toBe('AN017')
  })

  it('maps domain errors of otp_start to their HTTP status', async () => {
    const cases: Array<[string, string, number]> = [
      ['AN001', 'slot_taken', 409],
      ['AN009', 'not_bookable', 404],
      ['AN013', 'rate_limited', 429],
      ['AN017', 'sms_unavailable', 503],
      ['AN018', 'phone_not_supported', 422],
      ['AN019', 'otp_resend_too_soon', 429],
    ]
    for (const [code, name, status] of cases) {
      const h = harness()
      h.db.overrides.set('otp_start', () => raise(code, name))
      const { response, body } = await booking(h, startBody(KNOWN))
      expect(response.status, code).toBe(status)
      expect(body).toEqual({ error: { code, message: name } })
      expect(h.db.called('claim_messages')).toBe(0)
    }
  })

  it('answers 500 internal for a non-domain database error, logging only the SQLSTATE', async () => {
    const h = harness()
    h.db.overrides.set('otp_start', () => ({
      data: null,
      error: { code: '55000', message: `vault secret otp_hmac_key is missing for ${KNOWN}` },
    }))
    const { response, body } = await booking(h, startBody(KNOWN))
    expect(response.status).toBe(500)
    expect(errorCode(body)).toBe('internal')
    expect(JSON.stringify(h.logs)).toContain('55000')
    expect(JSON.stringify(h.logs)).not.toContain(KNOWN)
  })

  it('skips the SMS for a trusted device of this phone, and asks OTP for another phone', async () => {
    const h = harness()
    const { td } = await verified(h, KNOWN)
    const sent = h.sms.length

    const trusted = await booking(h, startBody(KNOWN), { [PROXY_HEADERS.trustedDevice]: td })
    expect(trusted.response.status).toBe(200)
    expect(StartResponse.parse(trusted.body)).toEqual({
      result: 'trusted',
      clients: h.db.clients.get(KNOWN),
    })
    expect(h.sms).toHaveLength(sent)

    const other = await booking(h, startBody(UNKNOWN), { [PROXY_HEADERS.trustedDevice]: td })
    expect(StartResponse.parse(other.body).result).toBe('otp_sent')
    expect(h.sms).toHaveLength(sent + 1)
  })

  it('ignores a malformed trusted-device header', async () => {
    const h = harness()
    const { body } = await booking(h, startBody(KNOWN), {
      [PROXY_HEADERS.trustedDevice]: 'short-token',
    })
    expect(StartResponse.parse(body).result).toBe('otp_sent')
    expect(h.db.called('clients_for_phone')).toBe(0)
  })
})

describe('public-booking: verify and clients', () => {
  it('returns the grant and the clients in the body, the device token only as a header', async () => {
    const h = harness()
    const started = StartResponse.parse((await booking(h, startBody(KNOWN))).body)
    if (started.result !== 'otp_sent') throw new Error('expected otp_sent')
    const { response, body } = await booking(h, {
      action: 'verify',
      business_id: BUSINESS,
      phone: KNOWN,
      challenge_id: started.challenge_id,
      code: TEST_CODE,
    })
    expect(response.status).toBe(200)
    const result = VerifyResponse.parse(body)
    expect(result.clients.map((client) => client.first_name)).toEqual(['Γιώργος', 'Μάριος'])
    const td = response.headers.get(PROXY_HEADERS.setTrustedDevice)
    expect(isBase64UrlOfLength(td, 32)).toBe(true)
    expect(JSON.stringify(body)).not.toContain(td)
  })

  it('maps wrong, expired and locked codes to AN010, AN011 and AN012', async () => {
    const h = harness()
    const started = StartResponse.parse((await booking(h, startBody(KNOWN))).body)
    if (started.result !== 'otp_sent') throw new Error('expected otp_sent')
    const attempt = (code: string, challenge = started.challenge_id) =>
      booking(h, {
        action: 'verify',
        business_id: BUSINESS,
        phone: KNOWN,
        challenge_id: challenge,
        code,
      })

    const wrong = await attempt('000000')
    expect(wrong.response.status).toBe(422)
    expect(wrong.body).toEqual({ error: { code: 'AN010', message: 'otp_invalid' } })
    expect(wrong.response.headers.get(PROXY_HEADERS.setTrustedDevice)).toBeNull()
    for (let i = 0; i < 3; i++) await attempt('000000')
    expect(errorCode((await attempt('000000')).body)).toBe('AN012')
    expect(errorCode((await attempt(TEST_CODE)).body)).toBe('AN012')
    expect(errorCode((await attempt(TEST_CODE, crypto.randomUUID())).body)).toBe('AN011')
  })

  it('lists clients with the grant, or with the trusted device, else AN014', async () => {
    const h = harness()
    const { grant, td } = await verified(h, KNOWN)
    const byGrant = await booking(h, {
      action: 'clients',
      business_id: BUSINESS,
      phone: KNOWN,
      grant,
    })
    expect(ClientsResponse.parse(byGrant.body).verified_via).toBe('otp')

    const byDevice = await booking(
      h,
      { action: 'clients', business_id: BUSINESS, phone: KNOWN, grant: null },
      { [PROXY_HEADERS.trustedDevice]: td },
    )
    expect(ClientsResponse.parse(byDevice.body).verified_via).toBe('trusted_device')

    const none = await booking(h, {
      action: 'clients',
      business_id: BUSINESS,
      phone: KNOWN,
      grant: null,
    })
    expect(none.response.status).toBe(403)
    expect(errorCode(none.body)).toBe('AN014')
  })
})

describe('public-booking: book', () => {
  it('books with the grant, sends the confirmation, and the SMS link opens the booking', async () => {
    const h = harness()
    const { grant } = await verified(h, REAL)
    const { response, body } = await booking(h, bookBody(REAL, grant))
    expect(response.status).toBe(200)
    const booked = BookResponse.parse(body)
    expect(booked).toMatchObject({ replayed: false, verified_via: 'otp' })
    expect(booked.next_visit_hint).toEqual({ key: 'nextVisit.vertical', weeks: 4 })
    expect(h.db.argsOf('book_appointment')).toMatchObject({
      p_client_id: null,
      p_new_client: { full_name: 'Νέος Πελάτης', locale: 'el' },
      p_grant: grant,
      p_trusted_device_token: null,
      p_marketing_box: 'unchecked',
      p_policy_version: PRIVACY_NOTICE_VERSION,
    })

    // The confirmation SMS carries its OWN token (§2.6.9), different from the page's.
    const smsToken = lastManageToken(h.sms)
    expect(smsToken).not.toBe(booked.manage_token)
    for (const token of [booked.manage_token, smsToken]) {
      const view = await manage(h, { action: 'view', token })
      expect(view.response.status).toBe(200)
      expect(ManageViewResponse.parse(view.body).appointment.id).toBe(booked.appointment.id)
    }
  })

  it('replays a retried book: same appointment, a new working link, nothing sent twice', async () => {
    const h = harness()
    const { grant } = await verified(h, REAL)
    const body = bookBody(REAL, grant)
    const first = BookResponse.parse((await booking(h, body)).body)
    const smsAfterFirst = h.sms.length

    const retry = await booking(h, body)
    expect(retry.response.status).toBe(200)
    const second = BookResponse.parse(retry.body)
    expect(second.appointment).toEqual(first.appointment)
    expect(second).toMatchObject({ replayed: true, verified_via: 'otp' })
    expect(second.manage_token).not.toBe(first.manage_token)
    expect(isManageToken(second.manage_token)).toBe(true)
    expect(h.db.appointments.size).toBe(1)
    expect(h.sms).toHaveLength(smsAfterFirst)

    const view = await manage(h, { action: 'view', token: second.manage_token })
    expect(ManageViewResponse.parse(view.body).appointment.id).toBe(first.appointment.id)

    // Another slot with the same key and the consumed grant: refused, not a second booking.
    const conflict = await booking(h, { ...body, starts_at: MOVED })
    expect(conflict.response.status).toBe(409)
    expect(errorCode(conflict.body)).toBe('AN004')
  })

  it('books with the trusted device and no grant; without either proof answers AN014', async () => {
    const h = harness()
    const { td } = await verified(h, KNOWN)
    const trusted = await booking(h, bookBody(KNOWN, null), { [PROXY_HEADERS.trustedDevice]: td })
    expect(BookResponse.parse(trusted.body).verified_via).toBe('trusted_device')

    const none = await booking(h, { ...bookBody(KNOWN, null), starts_at: MOVED })
    expect(none.response.status).toBe(403)
    expect(errorCode(none.body)).toBe('AN014')
  })

  it('never changes a committed booking into an error when the SMS fails', async () => {
    const h = harness()
    const { grant } = await verified(h, REAL)
    h.db.smsEnabled = false
    const { response, body } = await booking(h, bookBody(REAL, grant))
    expect(response.status).toBe(200)
    expect(BookResponse.parse(body).replayed).toBe(false)
  })

  it('answers AN001 (409) for a slot taken meanwhile', async () => {
    const h = harness()
    const { td } = await verified(h, KNOWN)
    const headers = { [PROXY_HEADERS.trustedDevice]: td }
    await booking(h, bookBody(KNOWN, null), headers)
    const second = await booking(h, bookBody(KNOWN, null), headers)
    expect(second.response.status).toBe(409)
    expect(second.body).toEqual({ error: { code: 'AN001', message: 'slot_taken' } })
  })

  it('answers 500 internal when the SQL result does not match the contract', async () => {
    const h = harness()
    const { td } = await verified(h, KNOWN)
    h.db.overrides.set('book_appointment', () => ok({ appointment_id: 'x' }))
    const { response } = await booking(h, bookBody(KNOWN, null), {
      [PROXY_HEADERS.trustedDevice]: td,
    })
    expect(response.status).toBe(500)
    expect(h.logs.map((line) => line.event)).toContain('rpc_invalid_result')
  })
})

describe('public-booking: forget', () => {
  it('revokes the device and tells the proxy to delete the cookie', async () => {
    const h = harness()
    const { td } = await verified(h, KNOWN)
    const headers = { [PROXY_HEADERS.trustedDevice]: td }
    const { response, body } = await booking(
      h,
      { action: 'forget', business_id: BUSINESS },
      headers,
    )
    expect(response.status).toBe(200)
    expect(ForgetResponse.parse(body)).toEqual({ forgotten: true })
    expect(response.headers.get(PROXY_HEADERS.setTrustedDevice)).toBe('')
    expect(h.db.argsOf('trusted_device_revoke')).toEqual({
      p_business_id: BUSINESS,
      p_trusted_device_token: td,
    })
    const again = await booking(h, startBody(KNOWN), headers)
    expect(StartResponse.parse(again.body).result).toBe('otp_sent')
  })

  it('clears the cookie even without a device token', async () => {
    const h = harness()
    const { response } = await booking(h, { action: 'forget', business_id: BUSINESS })
    expect(response.headers.get(PROXY_HEADERS.setTrustedDevice)).toBe('')
    expect(h.db.called('trusted_device_revoke')).toBe(0)
  })
})

describe('manage', () => {
  async function booked(h: Harness) {
    const { td } = await verified(h, KNOWN)
    const result = await booking(h, bookBody(KNOWN, null), { [PROXY_HEADERS.trustedDevice]: td })
    return BookResponse.parse(result.body)
  }

  it('shows the booking and strips anything outside the contract', async () => {
    const h = harness()
    const { manage_token } = await booked(h)
    const { response, body } = await manage(h, { action: 'view', token: manage_token })
    expect(response.status).toBe(200)
    expect(ManageViewResponse.safeParse(body).success).toBe(true)
    expect(JSON.stringify(body)).not.toContain('internal_note')
  })

  it('cancels, sends the short booking link, and every link stops working', async () => {
    const h = harness()
    const { manage_token } = await booked(h)
    const smsToken = lastManageToken(h.sms)
    const { response, body } = await manage(h, { action: 'cancel', token: manage_token })
    expect(response.status).toBe(200)
    expect(ManageCancelResponse.parse(body)).toEqual({ status: 'cancelled' })
    expect(h.sms.at(-1)).toContain('localhost:5173/r/demo01')
    for (const token of [manage_token, smsToken]) {
      const view = await manage(h, { action: 'view', token })
      expect(view.response.status).toBe(403)
      expect(errorCode(view.body)).toBe('AN015')
    }
  })

  it('lists the reschedule slots and moves, with a new link in the SMS', async () => {
    const h = harness()
    const { manage_token } = await booked(h)
    const slots = await manage(h, {
      action: 'slots',
      token: manage_token,
      from: '2026-10-07',
      to: '2026-10-08',
    })
    expect(ManageSlotsResponse.parse(slots.body).slots[0]?.starts_at).toBe(MOVED)
    expect(h.db.argsOf('manage_slots')).toEqual({
      p_token: manage_token,
      p_from: '2026-10-07',
      p_to: '2026-10-08',
    })

    const moved = await manage(h, { action: 'reschedule', token: manage_token, starts_at: MOVED })
    expect(moved.response.status).toBe(200)
    expect(ManageRescheduleResponse.parse(moved.body).appointment).toMatchObject({
      starts_at: MOVED,
      ends_at: MOVED_ENDS,
    })
    // 08:00 UTC = 11:00 in Athens, Wednesday; Greek in GSM-7 capitals.
    expect(h.sms.at(-1)).toContain('NEA ΩPA PANTEBOY TET 07/10 11:00 ME NIKOΣ')
    const view = await manage(h, { action: 'view', token: lastManageToken(h.sms) })
    expect(ManageViewResponse.parse(view.body).appointment.starts_at).toBe(MOVED)
  })

  it('answers AN015 for an unknown token and 400 for a malformed one', async () => {
    const h = harness()
    const unknown = await manage(h, { action: 'view', token: newToken(16) })
    expect(unknown.response.status).toBe(403)
    expect(errorCode(unknown.body)).toBe('AN015')
    const malformed = await manage(h, { action: 'view', token: 'abc' })
    expect(malformed.response.status).toBe(400)
    expect(h.db.called('manage_view')).toBe(1)
  })

  it('changes nothing on GET and refuses requests without the proxy secret', async () => {
    const h = harness()
    const get = await handleManage(request('manage', null, {}, 'GET'), h.runtime)
    expect(get.status).toBe(405)
    const direct = await handleManage(
      request('manage', { action: 'view', token: newToken(16) }, { [PROXY_HEADERS.secret]: '' }),
      h.runtime,
    )
    expect(direct.status).toBe(403)
    expect(h.db.calls).toEqual([])
  })
})

describe('logs', () => {
  it('never carry phones, codes, grants, tokens or names', async () => {
    const h = harness()
    const { grant, td } = await verified(h, REAL)
    const booked = BookResponse.parse((await booking(h, bookBody(REAL, grant))).body)
    await manage(h, { action: 'cancel', token: booked.manage_token })
    const code = /^(\d{6}) /m.exec(h.sms[0] ?? '')?.[1] ?? 'missing'
    const logged = JSON.stringify(h.logs)
    for (const secret of [REAL, code, grant, td, booked.manage_token, 'Νέος', 'Πελάτης']) {
      expect(logged, secret).not.toContain(secret)
    }
    expect(h.logs.filter((line) => line.event === 'request').length).toBeGreaterThan(0)
  })
})
