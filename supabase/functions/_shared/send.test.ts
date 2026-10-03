// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toBase64Url } from './base64url.ts'
import type { Log, LogValue, Rpc, RpcResult } from './booking-rpc.ts'
import { formatInZone } from './dates.ts'
import type { OneSignalPushPayload } from './onesignal.ts'
import {
  createFakePushProvider,
  type PushProvider,
  type PushSendRequest,
  type SendResult,
} from './push-provider.ts'
import {
  manageLink,
  messageVariables,
  pushUrl,
  pushVariables,
  sendClaimed,
  sendMessages,
  shortLink,
  SMS_DATE_PATTERN,
  type ClaimedPush,
  type ClaimedSms,
  type SendConfig,
} from './send.ts'
import { gsm7Septets, SMS_VARIABLE_LIMITS, toGsm7Text } from './sms.ts'
import type { SmsProvider, SmsSendRequest } from './sms-provider.ts'

const MESSAGE_ID = '6b0e8f3c-1a2d-4e5f-8a9b-0c1d2e3f4a5b'
const OTHER_ID = '7c1f9a4d-2b3e-4f60-9bac-1d2e3f4a5b6c'
const PUSH_ID = '9e3b1c6f-4d5a-4b82-9dce-3f4a5b6c7d8e'
const LEASE_ID = '8d2a0b5e-3c4f-4a71-8cbd-2e3f4a5b6c7d'
const PHONE = '+306900000001'
const TOKEN = toBase64Url(new Uint8Array(16).fill(250)) // 22 chars, with '-' and '_'
const DEVICE = '8b1f6a52-3c1e-4c0d-9a4e-2f7d1c9b0e11'
const OTHER_DEVICE = '0c7e1d2a-9b4f-4e3a-8d6c-5a1b2c3d4e5f'

const CONFIG: SendConfig = {
  siteHost: 'localhost:5173',
  smsDomain: 'localhost',
  allowedRecipients: new Set(),
}

/** An SMS item of claim_messages / claim_due_messages (contract 1.5 §2.8): every key present. */
function row(overrides: Partial<ClaimedSms> & Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    lease_id: LEASE_ID,
    channel: 'sms' as const,
    template: 'booking_confirmed' as ClaimedSms['template'],
    category: 'transactional',
    locale: 'el' as const,
    business_name: 'Κουρείο Demo',
    short_code: 'demo01',
    timezone: 'Europe/Athens',
    starts_at: '2026-10-06T07:00:00+00:00' as string | null,
    staff_name: 'Νίκος' as string | null,
    to_e164: PHONE,
    manage_token: TOKEN as string | null,
    client_first_name: null,
    service_name: null,
    push_targets: null,
    ...overrides,
  }
}

/** A push item: the recipient's devices, the client's first name, never a phone. */
function pushItem(overrides: Partial<ClaimedPush> & Record<string, unknown> = {}) {
  return {
    id: PUSH_ID,
    lease_id: LEASE_ID,
    channel: 'push' as const,
    template: 'push_booking_created' as ClaimedPush['template'],
    category: 'transactional',
    locale: 'el' as const,
    business_name: 'Κουρείο Demo',
    short_code: 'demo01',
    timezone: 'Europe/Athens' as string | null,
    starts_at: '2026-10-06T07:00:00+00:00' as string | null,
    staff_name: 'Νίκος' as string | null,
    to_e164: null,
    manage_token: null,
    client_first_name: 'Γιώργος' as string | null,
    service_name: 'Κούρεμα' as string | null,
    push_targets: [
      { provider: 'onesignal', subscription_id: DEVICE },
    ] as ClaimedPush['push_targets'],
    ...overrides,
  }
}

type Call = { fn: string; args: Readonly<Record<string, unknown>> }

function fakeRpc(claimed: unknown[] | RpcResult, recordResult: RpcResult = ok(true)) {
  const calls: Call[] = []
  const rpc: Rpc = (fn, args) => {
    calls.push({ fn, args })
    if (fn === 'claim_messages') {
      return Promise.resolve(Array.isArray(claimed) ? ok(claimed) : claimed)
    }
    if (fn === 'record_send_result') return Promise.resolve(recordResult)
    return Promise.reject(new Error(`unexpected rpc ${fn}`))
  }
  const records = () => calls.filter((call) => call.fn === 'record_send_result').map((c) => c.args)
  return { rpc, calls, records }
}

function ok(data: unknown): RpcResult {
  return { data, error: null }
}

function fakeProvider(answer: SendResult | Error = okSend()) {
  const sent: SmsSendRequest[] = []
  const provider: SmsProvider = {
    name: 'fake',
    send(message) {
      sent.push(message)
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
  }
  return { provider, sent }
}

function okSend(): SendResult {
  return { ok: true, providerMessageId: 'fake-1', segments: 1, costCents: 0 }
}

/** The real fake push sender, with its payloads captured (the Vitest observation point). */
function fakePush() {
  const payloads: OneSignalPushPayload[] = []
  const pushProvider = createFakePushProvider({
    env: 'dev',
    record: (payload) => payloads.push(payload),
    randomId: () => '00000000-0000-4000-8000-0000000000ff',
  })
  return { pushProvider, payloads }
}

/** A push sender that answers `answer` and keeps the requests. */
function scriptedPush(answer: SendResult | Error) {
  const requests: PushSendRequest[] = []
  const pushProvider: PushProvider = {
    name: 'onesignal',
    send(request) {
      requests.push(request)
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
  }
  return { pushProvider, requests }
}

function recordingLog() {
  const lines: Array<{ event: string; fields: Readonly<Record<string, LogValue>> }> = []
  const log: Log = (event, fields) => lines.push({ event, fields })
  return { log, lines }
}

function options(
  db: ReturnType<typeof fakeRpc>,
  provider: SmsProvider,
  extra: Partial<Parameters<typeof sendMessages>[0]> = {},
) {
  return {
    rpc: db.rpc,
    provider,
    pushProvider: fakePush().pushProvider,
    config: CONFIG,
    ids: [MESSAGE_ID],
    log: () => {},
    ...extra,
  }
}

describe('sendMessages: SMS', () => {
  it('claims, renders in the client language and zone, sends and records the result', async () => {
    const db = fakeRpc([row()])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages(options(db, provider))

    expect(outcomes).toEqual({ [MESSAGE_ID]: 'sent' })
    expect(db.calls[0]).toEqual({ fn: 'claim_messages', args: { p_ids: [MESSAGE_ID] } })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(PHONE)
    expect(sent[0]?.segments).toBe(1)
    // 07:00 UTC is 10:00 in Athens (EEST); Greek in GSM-7 capitals; the link byte-for-byte.
    expect(sent[0]?.text).toContain('TPI 06/10 10:00')
    expect(sent[0]?.text).toContain('NIKOΣ')
    expect(sent[0]?.text).toContain(`localhost:5173/m/${TOKEN}`)
    expect(db.records()).toEqual([
      {
        p_id: MESSAGE_ID,
        p_lease_id: LEASE_ID,
        p_outcome: 'sent',
        p_provider: 'fake',
        p_provider_message_id: 'fake-1',
        p_segments: 1,
        p_cost_cents: 0,
        p_error: null,
      },
    ])
  })

  it('uses the time zone of the row, never a fixed one', async () => {
    const db = fakeRpc([row({ timezone: 'America/New_York', locale: 'en' })])
    const { provider, sent } = fakeProvider()
    await sendMessages(options(db, provider))
    expect(sent[0]?.text).toContain('Tue 06/10 03:00')
  })

  it('puts the in-memory OTP code and the WebOTP domain into the OTP SMS', async () => {
    const otpRow = row({ template: 'otp', starts_at: null, staff_name: null, manage_token: null })
    const db = fakeRpc([otpRow])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages(
      options(db, provider, { extraVars: { [MESSAGE_ID]: { code: '424242' } } }),
    )
    expect(outcomes[MESSAGE_ID]).toBe('sent')
    expect(sent[0]?.text.startsWith('424242 ')).toBe(true)
    expect(sent[0]?.text.endsWith('@localhost #424242')).toBe(true)
  })

  it('links a cancellation to the short booking link /r/<code>', async () => {
    for (const template of ['cancelled_by_client', 'cancelled_by_business'] as const) {
      const db = fakeRpc([row({ template, manage_token: null })])
      const { provider, sent } = fakeProvider()
      await sendMessages(options(db, provider))
      expect(sent[0]?.text).toContain('localhost:5173/r/demo01')
      expect(sent[0]?.text).not.toContain('/m/')
    }
  })

  it('gives rescheduled_by_business (1.5) a manage link, one SMS with the new time', async () => {
    const db = fakeRpc([row({ template: 'rescheduled_by_business' })])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages(options(db, provider))
    expect(outcomes[MESSAGE_ID]).toBe('sent')
    expect(sent[0]?.segments).toBe(1)
    expect(sent[0]?.text).toContain(`localhost:5173/m/${TOKEN}`)
    expect(sent[0]?.text).toContain('TPI 06/10 10:00')

    // Without its token it is a render error, never an SMS without a link.
    const missing = fakeRpc([row({ template: 'rescheduled_by_business', manage_token: null })])
    const other = fakeProvider()
    expect((await sendMessages(options(missing, other.provider)))[MESSAGE_ID]).toBe('failed')
    expect(other.sent).toEqual([])
  })

  it('rejects a recipient outside SMS_ALLOWED_RECIPIENTS without calling the adapter', async () => {
    const db = fakeRpc([row()])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages(
      options(db, provider, {
        config: { ...CONFIG, allowedRecipients: new Set(['+306912345678']) },
      }),
    )
    expect(outcomes[MESSAGE_ID]).toBe('rejected')
    expect(sent).toEqual([])
    expect(db.records()[0]).toMatchObject({
      p_outcome: 'rejected',
      p_provider: null,
      p_error: 'recipient_not_allowed',
    })
  })

  it('sends to a listed recipient', async () => {
    const db = fakeRpc([row()])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages(
      options(db, provider, { config: { ...CONFIG, allowedRecipients: new Set([PHONE]) } }),
    )
    expect(outcomes[MESSAGE_ID]).toBe('sent')
    expect(sent).toHaveLength(1)
  })

  it('answers not_claimed for ids the claim did not return, and never sends them', async () => {
    const db = fakeRpc([row()])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages(options(db, provider, { ids: [MESSAGE_ID, OTHER_ID] }))
    expect(outcomes).toEqual({ [MESSAGE_ID]: 'sent', [OTHER_ID]: 'not_claimed' })
    expect(sent).toHaveLength(1)
  })

  it('treats a failed or empty claim as not_claimed (switched off, cap reached, already taken)', async () => {
    for (const claimed of [
      { data: null, error: { code: '55000', message: 'vault secret otp_hmac_key is missing' } },
      ok([]),
      ok(null),
    ]) {
      const db = fakeRpc(claimed)
      const { provider, sent } = fakeProvider()
      const outcomes = await sendMessages(options(db, provider))
      expect(outcomes).toEqual({ [MESSAGE_ID]: 'not_claimed' })
      expect(sent).toEqual([])
      expect(db.records()).toEqual([])
    }
  })

  it('does nothing for no ids', async () => {
    const db = fakeRpc([])
    const { provider } = fakeProvider()
    expect(await sendMessages(options(db, provider, { ids: [] }))).toEqual({})
    expect(db.calls).toEqual([])
  })

  it('records what the adapter answered: failed, rejected or unknown, with a code only', async () => {
    const cases: Array<[SendResult, string, string]> = [
      // Free text may carry the number: only something shaped like a code is kept.
      [
        { ok: false, outcome: 'failed', error: 'invalid number: +306900000001' },
        'failed',
        'provider_error',
      ],
      [{ ok: false, outcome: 'failed', error: 'rate_limited' }, 'failed', 'rate_limited'],
      [{ ok: false, outcome: 'rejected', error: 'blocked' }, 'rejected', 'blocked'],
      [{ ok: false, outcome: 'unknown', error: 'timeout' }, 'unknown', 'timeout'],
    ]
    for (const [answer, outcome, error] of cases) {
      const db = fakeRpc([row()])
      const { provider } = fakeProvider(answer)
      const outcomes = await sendMessages(options(db, provider))
      expect(outcomes[MESSAGE_ID]).toBe(outcome)
      expect(db.records()[0]).toMatchObject({
        p_outcome: outcome,
        p_provider: 'fake',
        p_error: error,
        p_provider_message_id: null,
      })
    }
  })

  it('records unknown (never retried) when the adapter throws: it may have left', async () => {
    const db = fakeRpc([row()])
    const { provider } = fakeProvider(new Error('socket hang up'))
    const outcomes = await sendMessages(options(db, provider))
    expect(outcomes[MESSAGE_ID]).toBe('unknown')
    expect(db.records()[0]).toMatchObject({ p_outcome: 'unknown', p_error: 'provider_exception' })
  })

  it('records render_error (and sends nothing) when a row lacks what its template needs', async () => {
    for (const bad of [
      row({ manage_token: null }),
      row({ template: 'cancelled_by_client', short_code: 'NOTOK!' }),
      row({ template: 'otp', starts_at: null, staff_name: null, manage_token: null }), // no code
      row({ timezone: 'Not/AZone' }),
    ]) {
      const db = fakeRpc([bad])
      const { provider, sent } = fakeProvider()
      const outcomes = await sendMessages(options(db, provider))
      expect(outcomes[MESSAGE_ID]).toBe('failed')
      expect(sent).toEqual([])
      expect(db.records()[0]).toMatchObject({ p_outcome: 'failed', p_error: 'render_error' })
    }
  })

  it('releases the lease of a malformed claimed row as failed', async () => {
    for (const malformed of [
      { id: MESSAGE_ID, lease_id: LEASE_ID, template: 'unknown_template' },
      { ...row(), channel: 'fax' },
      { ...row(), channel: undefined },
    ]) {
      const db = fakeRpc([malformed])
      const { provider, sent } = fakeProvider()
      const outcomes = await sendMessages(options(db, provider))
      expect(outcomes[MESSAGE_ID]).toBe('failed')
      expect(sent).toEqual([])
      expect(db.records()[0]).toMatchObject({ p_outcome: 'failed', p_error: 'invalid_claim' })
    }
  })

  it('keeps the outcome when recording fails (the sweep settles the row)', async () => {
    const db = fakeRpc([row()], { data: null, error: { code: '40001', message: 'x' } })
    const { provider } = fakeProvider()
    const { log, lines } = recordingLog()
    const outcomes = await sendMessages(options(db, provider, { log }))
    expect(outcomes[MESSAGE_ID]).toBe('sent')
    expect(lines.map((line) => line.event)).toContain('message_record_failed')
  })

  it('bounds what it records to the CHECKs of messages_log', async () => {
    const db = fakeRpc([row()])
    const { provider } = fakeProvider({
      ok: true,
      providerMessageId: 'x'.repeat(500),
      segments: 42,
      costCents: 3.6,
    })
    await sendMessages(options(db, provider))
    const recorded = db.records()[0]
    expect(String(recorded?.p_provider_message_id)).toHaveLength(120)
    expect(recorded?.p_segments).toBe(10)
    expect(recorded?.p_cost_cents).toBe(4)
  })

  it('takes the prepared segments when the adapter reports none', async () => {
    const db = fakeRpc([row()])
    const { provider } = fakeProvider({ ok: true, providerMessageId: 'p-1' })
    await sendMessages(options(db, provider))
    expect(db.records()[0]).toMatchObject({ p_segments: 1, p_cost_cents: null })
  })

  it('never logs a phone number, a code, a token or a text', async () => {
    const otpRow = row({ template: 'otp', starts_at: null, staff_name: null, manage_token: null })
    const db = fakeRpc([row({ id: OTHER_ID }), otpRow])
    const { provider } = fakeProvider()
    const { log, lines } = recordingLog()
    await sendMessages(
      options(db, provider, {
        ids: [MESSAGE_ID, OTHER_ID],
        extraVars: { [MESSAGE_ID]: { code: '424242' } },
        log,
      }),
    )
    const logged = JSON.stringify(lines)
    for (const secret of [PHONE, '424242', TOKEN, 'Νίκος', 'NIKOΣ', 'demo01']) {
      expect(logged).not.toContain(secret)
    }
    expect(lines.filter((line) => line.event === 'message_send')).toHaveLength(2)
  })
})

describe('sendMessages: push (contract 1.5 §3.2)', () => {
  it('sends to exactly the OneSignal devices of the item, with el and en texts and the day link', async () => {
    const db = fakeRpc([
      pushItem({
        push_targets: [
          { provider: 'onesignal', subscription_id: DEVICE },
          { provider: 'vapid' },
          { provider: 'onesignal', subscription_id: OTHER_DEVICE },
        ],
      }),
    ])
    const { provider, sent } = fakeProvider()
    const push = fakePush()
    const outcomes = await sendMessages({
      ...options(db, provider, { ids: [PUSH_ID] }),
      pushProvider: push.pushProvider,
    })

    expect(outcomes).toEqual({ [PUSH_ID]: 'sent' })
    expect(sent).toEqual([]) // no SMS
    expect(push.payloads).toHaveLength(1)
    const payload = push.payloads[0]
    // Only include_subscription_ids from push_subscriptions (VAPID skipped) + target_channel.
    expect(payload?.include_subscription_ids).toEqual([DEVICE, OTHER_DEVICE])
    expect(payload?.target_channel).toBe('push')
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'app_id',
      'contents',
      'headings',
      'include_subscription_ids',
      'target_channel',
      'url',
    ])
    // 07:00 UTC = 10:00 Athens, Tuesday 06/10: the business's zone, both languages.
    expect(payload?.headings).toEqual({ el: 'Νέα κράτηση', en: 'New booking' })
    expect(payload?.contents).toEqual({
      el: 'Γιώργος · Κούρεμα · Τρί 06/10 10:00 με Νίκος',
      en: 'Γιώργος · Κούρεμα · Tue 06/10 10:00 with Νίκος',
    })
    expect(payload?.url).toBe('http://localhost:5173/app/day?date=2026-10-06')
    expect(db.records()).toEqual([
      {
        p_id: PUSH_ID,
        p_lease_id: LEASE_ID,
        p_outcome: 'sent',
        p_provider: 'fake',
        p_provider_message_id: 'fake-push-00000000-0000-4000-8000-0000000000ff',
        p_segments: null,
        p_cost_cents: null,
        p_error: null,
      },
    ])
  })

  it('carries the first name only: never the surname or the phone', async () => {
    const db = fakeRpc([
      pushItem({
        client_first_name: 'Γιώργος Παπαδόπουλος',
        // Even if a row ever carried the phone, the push schema never reads it.
        to_e164: PHONE,
        notes: 'αλλεργία',
      }),
    ])
    const push = fakePush()
    await sendMessages({
      ...options(db, fakeProvider().provider, { ids: [PUSH_ID] }),
      pushProvider: push.pushProvider,
    })
    const serialised = JSON.stringify(push.payloads)
    expect(serialised).toContain('Γιώργος')
    for (const personal of ['Παπαδόπουλος', '+30', '6900000001', 'αλλεργία']) {
      expect(serialised).not.toContain(personal)
    }
  })

  it('uses the language fallback when there is no client name, and caps long values', () => {
    const item = pushItem({
      template: 'push_booking_cancelled',
      client_first_name: null,
      staff_name: 'Παναγιώτης-Χρυσόστομος Κωνσταντινόπουλος',
    })
    const parsedEl = pushVariables(item, 'el')
    const parsedEn = pushVariables(item, 'en')
    expect(parsedEl.client).toBe('Πελάτης')
    expect(parsedEn.client).toBe('Client')
    expect(Array.from(parsedEl.staff ?? '')).toHaveLength(20)
    expect(parsedEl.staff?.endsWith('…')).toBe(true)
    expect(parsedEl.date).toBe('Τρί 06/10')
    expect(parsedEn.date).toBe('Tue 06/10')
  })

  it('opens the business-local day of the appointment, or /app/ for the test push', () => {
    // 22:30 UTC on the 5th is already the 6th in Athens.
    const late = pushItem({ starts_at: '2026-10-05T22:30:00+00:00' })
    expect(pushUrl('localhost:5173', late)).toBe('http://localhost:5173/app/day?date=2026-10-06')
    expect(pushUrl('dev.anaklo.gr', late)).toBe('https://dev.anaklo.gr/app/day?date=2026-10-06')
    const ny = pushItem({ starts_at: '2026-10-06T02:00:00+00:00', timezone: 'America/New_York' })
    expect(pushUrl('dev.anaklo.gr', ny)).toBe('https://dev.anaklo.gr/app/day?date=2026-10-05')
    const test = pushItem({
      template: 'push_test',
      starts_at: null,
      timezone: 'Europe/Athens',
      staff_name: null,
      client_first_name: null,
      service_name: null,
    })
    expect(pushUrl('dev.anaklo.gr', test)).toBe('https://dev.anaklo.gr/app/')
  })

  it('sends the test push without an appointment', async () => {
    const db = fakeRpc([
      pushItem({
        template: 'push_test',
        starts_at: null,
        staff_name: null,
        client_first_name: null,
        service_name: null,
      }),
    ])
    const push = fakePush()
    const outcomes = await sendMessages({
      ...options(db, fakeProvider().provider, { ids: [PUSH_ID] }),
      pushProvider: push.pushProvider,
    })
    expect(outcomes[PUSH_ID]).toBe('sent')
    expect(push.payloads[0]?.headings.el).toBe('Δοκιμαστική ειδοποίηση')
    expect(push.payloads[0]?.url).toBe('http://localhost:5173/app/')
  })

  it('rejects provider_not_configured when no OneSignal device is left (VAPID skipped)', async () => {
    const vapid = { provider: 'vapid' as const, endpoint: 'https://push.example/x' }
    for (const targets of [[], [vapid]]) {
      const db = fakeRpc([pushItem({ push_targets: targets })])
      const push = scriptedPush({ ok: true, providerMessageId: 'x' })
      const outcomes = await sendMessages({
        ...options(db, fakeProvider().provider, { ids: [PUSH_ID] }),
        pushProvider: push.pushProvider,
      })
      expect(outcomes[PUSH_ID]).toBe('rejected')
      expect(push.requests).toEqual([])
      expect(db.records()[0]).toMatchObject({
        p_outcome: 'rejected',
        p_provider: null,
        p_error: 'provider_not_configured',
      })
    }
  })

  it('records the sender answer: not_subscribed, http_503, timeout, and unknown on a throw', async () => {
    const cases: Array<[SendResult | Error, string, string]> = [
      [{ ok: false, outcome: 'rejected', error: 'not_subscribed' }, 'rejected', 'not_subscribed'],
      [{ ok: false, outcome: 'failed', error: 'http_503' }, 'failed', 'http_503'],
      [{ ok: false, outcome: 'unknown', error: 'timeout' }, 'unknown', 'timeout'],
      [new Error('boom'), 'unknown', 'provider_exception'],
    ]
    for (const [answer, outcome, error] of cases) {
      const db = fakeRpc([pushItem()])
      const push = scriptedPush(answer)
      const outcomes = await sendMessages({
        ...options(db, fakeProvider().provider, { ids: [PUSH_ID] }),
        pushProvider: push.pushProvider,
      })
      expect(outcomes[PUSH_ID]).toBe(outcome)
      expect(db.records()[0]).toMatchObject({
        p_outcome: outcome,
        p_provider: 'onesignal',
        p_error: error,
      })
    }
  })

  it('records render_error for an appointment push without its time zone or staff', async () => {
    for (const bad of [pushItem({ timezone: null }), pushItem({ staff_name: null })]) {
      const db = fakeRpc([bad])
      const push = scriptedPush({ ok: true, providerMessageId: 'x' })
      const outcomes = await sendMessages({
        ...options(db, fakeProvider().provider, { ids: [PUSH_ID] }),
        pushProvider: push.pushProvider,
      })
      expect(outcomes[PUSH_ID]).toBe('failed')
      expect(push.requests).toEqual([])
      expect(db.records()[0]).toMatchObject({ p_outcome: 'failed', p_error: 'render_error' })
    }
  })

  it('refuses a device id that is not a OneSignal subscription id (invalid claim)', async () => {
    const db = fakeRpc([
      pushItem({ push_targets: [{ provider: 'onesignal', subscription_id: 'owner@demo.test' }] }),
    ])
    const push = fakePush()
    const outcomes = await sendMessages({
      ...options(db, fakeProvider().provider, { ids: [PUSH_ID] }),
      pushProvider: push.pushProvider,
    })
    expect(outcomes[PUSH_ID]).toBe('failed')
    expect(push.payloads).toEqual([])
    expect(db.records()[0]).toMatchObject({ p_error: 'invalid_claim' })
  })

  it('never logs subscription ids, names or texts', async () => {
    const db = fakeRpc([pushItem()])
    const { log, lines } = recordingLog()
    await sendMessages({
      ...options(db, fakeProvider().provider, { ids: [PUSH_ID], log }),
      pushProvider: fakePush().pushProvider,
    })
    const logged = JSON.stringify(lines)
    for (const secret of [DEVICE, 'Γιώργος', 'Νίκος', 'Κούρεμα', 'Νέα κράτηση']) {
      expect(logged).not.toContain(secret)
    }
    expect(lines).toContainEqual({
      event: 'message_send',
      fields: {
        id: PUSH_ID,
        channel: 'push',
        template: 'push_booking_created',
        outcome: 'sent',
        error: null,
      },
    })
  })
})

describe('sendMessages: the security alert (contract 1.9 §3.5)', () => {
  /** A `push_security_alert` row as claim_core returns it: no appointment, the owner's devices. */
  function alertItem(overrides: Partial<ClaimedPush> & Record<string, unknown> = {}) {
    return pushItem({
      template: 'push_security_alert',
      starts_at: null,
      staff_name: null,
      client_first_name: null,
      service_name: null,
      ...overrides,
    })
  }

  it('names the business only, opens Settings → Members, to the item devices only', async () => {
    const db = fakeRpc([alertItem()])
    const push = fakePush()
    const outcomes = await sendMessages({
      ...options(db, fakeProvider().provider, { ids: [PUSH_ID] }),
      pushProvider: push.pushProvider,
    })
    expect(outcomes[PUSH_ID]).toBe('sent')
    expect(push.payloads).toHaveLength(1)
    const payload = push.payloads[0]
    expect(payload?.include_subscription_ids).toEqual([DEVICE])
    expect(payload?.headings).toEqual({ el: 'Ειδοποίηση ασφαλείας', en: 'Security alert' })
    expect(payload?.contents.el).toBe(
      'Κουρείο Demo: μια συσκευή κωδικών άλλαξε χωρίς έγκριση. Δες το email σου.',
    )
    expect(payload?.contents.en).toBe(
      'Κουρείο Demo: an authenticator device changed without approval. Check your email.',
    )
    expect(payload?.url).toBe('http://localhost:5173/app/settings/members')
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'app_id',
      'contents',
      'headings',
      'include_subscription_ids',
      'target_channel',
      'url',
    ])
  })

  it('caps a long business name to 32 characters', () => {
    const long = 'Κομμωτήριο Ομορφιάς και Περιποίησης Αγία Παρασκευή'
    const vars = pushVariables(alertItem({ business_name: long }), 'el')
    expect(Array.from(vars.business ?? '')).toHaveLength(32)
    expect(vars.business?.endsWith('…')).toBe(true)
  })

  it('opens https on a public host', () => {
    expect(pushUrl('dev.anaklo.gr', alertItem())).toBe('https://dev.anaklo.gr/app/settings/members')
  })

  it('fails to render (and sends nothing) without the business name', async () => {
    for (const name of [null, '  ']) {
      const db = fakeRpc([alertItem({ business_name: name })])
      const push = scriptedPush({ ok: true, providerMessageId: 'x' })
      const outcomes = await sendMessages({
        ...options(db, fakeProvider().provider, { ids: [PUSH_ID] }),
        pushProvider: push.pushProvider,
      })
      expect(outcomes[PUSH_ID]).toBe('failed')
      expect(push.requests).toEqual([])
      expect(db.records()[0]).toMatchObject({ p_outcome: 'failed', p_error: 'render_error' })
    }
  })
})

describe('sendClaimed (the dispatcher path)', () => {
  it('sends SMS and push items of one batch and returns every outcome', async () => {
    const db = fakeRpc([])
    const push = fakePush()
    const { provider, sent } = fakeProvider()
    const outcomes = await sendClaimed(
      { rpc: db.rpc, provider, pushProvider: push.pushProvider, config: CONFIG, log: () => {} },
      [
        row({ template: 'reminder' }),
        pushItem({ template: 'push_booking_moved' }),
        { id: OTHER_ID, lease_id: LEASE_ID, channel: 'sms' },
      ],
    )
    expect(outcomes).toEqual({ [MESSAGE_ID]: 'sent', [PUSH_ID]: 'sent', [OTHER_ID]: 'failed' })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('YΠENΘYMIΣH')
    expect(push.payloads[0]?.contents.el).toBe('Γιώργος · νέα ώρα Τρί 06/10 10:00 με Νίκος')
    expect(db.calls.map((call) => call.fn)).toEqual([
      'record_send_result',
      'record_send_result',
      'record_send_result',
    ])
  })
})

describe('SMS variables of send.ts', () => {
  it('formats every weekday within the 9-septet date budget, in both languages', () => {
    for (let day = 0; day < 7; day++) {
      const instant = new Date(Date.UTC(2026, 11, 27 + day, 21, 30))
      for (const locale of ['el', 'en'] as const) {
        const date = formatInZone(instant, 'Europe/Athens', SMS_DATE_PATTERN, locale)
        expect(gsm7Septets(toGsm7Text(date)), date).toBeLessThanOrEqual(SMS_VARIABLE_LIMITS.date)
      }
    }
  })

  it('builds links without a scheme that fit the 40-septet budget with the longest SITE_HOST', () => {
    const longestHost = 'abcdefghij.k.gr' // 15 = MAX_SITE_HOST_LENGTH
    expect(manageLink(longestHost, TOKEN)).toHaveLength(SMS_VARIABLE_LIMITS.link)
    expect(manageLink('localhost:5173', TOKEN)).toBe(`localhost:5173/m/${TOKEN}`)
    expect(shortLink('dev.anaklo.gr', 'demo01')).toBe('dev.anaklo.gr/r/demo01')
    const vars = messageVariables(row(), {
      siteHost: longestHost,
      smsDomain: 'abcdefghij.k.gr',
    })
    expect(vars.link).toBe(`${longestHost}/m/${TOKEN}`)
  })
})
