// @vitest-environment node
// Request/Response/Headers from Node (undici), the same Fetch API the Deno runtime provides.
//
// `dispatch` (contract 1.5 §3.1) against an in-memory stand-in of `claim_due_messages`,
// `record_send_result` and `record_dispatch_run`, with the real fake SMS adapter and the real
// fake push sender. The SQL itself (leases, caps, deadlines, the sweep) is tested by pgTAP
// (12_messaging) and the concurrency by tests/db/dispatch-race.test.ts.
// 1.9 (contract 1.9 §3.2): the security phase runs first (`claim_security_events` and friends,
// in detail in security-handler.test.ts); here only how it joins the run.
import { describe, expect, it } from 'vitest'
import { toBase64Url } from './base64url.ts'
import type { LogValue, Rpc, RpcResult } from './booking-rpc.ts'
import {
  DISPATCH_MAX_BODY_BYTES,
  DISPATCH_SECRET_HEADER,
  DISPATCH_TIME_BUDGET_MS,
  handleDispatch,
} from './dispatch-handler.ts'
import {
  buildDispatchRuntime,
  LOCAL_DISPATCH_SECRET,
  type DispatchEnv,
  type DispatchRuntime,
} from './dispatch-runtime.ts'
import type { EmailSendRequest } from './email-provider.ts'
import type { FactorsAdminPort } from './member-functions.ts'
import type { OneSignalPushPayload } from './onesignal.ts'

const SECRET = LOCAL_DISPATCH_SECRET
const STARTS = '2026-10-06T07:00:00+00:00'
const DEVICE = '8b1f6a52-3c1e-4c0d-9a4e-2f7d1c9b0e11'
const PHONE = '+306900000001'
const TOKEN = toBase64Url(new Uint8Array(16).fill(7))

const LOCAL_ENV: DispatchEnv = {
  SUPABASE_URL: 'http://kong:8000',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  DISPATCH_SECRET: SECRET,
  ANAKLO_ENV: 'local',
  SITE_HOST: 'localhost:5173',
  SMS_PROVIDER: 'fake',
  SMS_ALLOWED_RECIPIENTS: '',
  PUSH_PROVIDER: 'fake',
  EMAIL_PROVIDER: 'fake',
  SUPPORT_EMAIL: 'support@example.com',
}

/** Nothing happened on the security side (1.9): the answer's `security` counts. */
const NO_SECURITY = { claimed: 0, contained: 0, notified: 0, failed: 0 }
const OWNER_DEVICE = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d'
const MEMBER = '3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'
const FACTOR = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d'

type Args = Readonly<Record<string, unknown>>

function smsItem(template = 'reminder') {
  return {
    id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    channel: 'sms',
    template,
    category: template === 'reminder' ? 'reminder' : 'transactional',
    locale: 'el',
    business_name: 'Κουρείο Demo',
    short_code: 'demo01',
    timezone: 'Europe/Athens',
    starts_at: STARTS,
    staff_name: 'Νίκος',
    to_e164: PHONE,
    manage_token: TOKEN,
    client_first_name: null,
    service_name: null,
    push_targets: null,
  }
}

function pushItem(template = 'push_booking_created') {
  return {
    id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    channel: 'push',
    template,
    category: 'transactional',
    locale: 'el',
    business_name: 'Κουρείο Demo',
    short_code: 'demo01',
    timezone: 'Europe/Athens',
    starts_at: STARTS,
    staff_name: 'Νίκος',
    to_e164: null,
    manage_token: null,
    client_first_name: 'Γιώργος',
    service_name: 'Κούρεμα',
    push_targets: [{ provider: 'onesignal', subscription_id: DEVICE }],
  }
}

/** A `push_security_alert` row (1.9) as claim_core returns it: no appointment, owner devices. */
function securityPushItem() {
  return {
    ...pushItem('push_security_alert'),
    starts_at: null,
    staff_name: null,
    client_first_name: null,
    service_name: null,
    push_targets: [{ provider: 'onesignal', subscription_id: OWNER_DEVICE }],
  }
}

/** One event of claim_security_events (1.9). */
function securityEvent(kind = 'factor_added_unauthorized') {
  return {
    id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    kind,
    user_id: MEMBER,
    factor_id: FACTOR,
    attempts: 1,
  }
}

/** The bundle of the `contained` answer: the member and one owner (D13). */
const NOTIFY = {
  kind: 'factor_added_unauthorized',
  detected_at: '2026-10-03T18:07:12+00:00',
  push_queued: 1,
  emails: [
    {
      audience: 'user',
      to: 'manager@demo-barber.test',
      locale: 'el',
      timezone: 'Europe/Athens',
      business_name: null,
      account_email: 'manager@demo-barber.test',
    },
    {
      audience: 'owner',
      to: 'owner@demo-barber.test',
      locale: 'el',
      timezone: 'Europe/Athens',
      business_name: 'Κουρείο Demo',
      account_email: 'manager@demo-barber.test',
    },
  ],
}

/**
 * Hands out the given batches in order (then empty ones), like claim_due_messages(5); the
 * security events likewise, like claim_security_events(1) (1.9).
 */
class FakeDb {
  readonly calls: Array<{ fn: string; args: Args }> = []
  readonly batches: Array<{ items: unknown[]; more: boolean } | RpcResult>
  readonly events: Array<{ items: unknown[]; more: boolean } | RpcResult> = []
  readonly overrides = new Map<string, (args: Args) => RpcResult>()

  constructor(batches: Array<{ items: unknown[]; more: boolean } | RpcResult> = []) {
    this.batches = [...batches]
  }

  readonly rpc: Rpc = (fn, args) => {
    this.calls.push({ fn, args })
    const override = this.overrides.get(fn)
    if (override) return Promise.resolve(override(args))
    switch (fn) {
      case 'claim_security_events': {
        const next = this.events.shift() ?? { items: [], more: false }
        return Promise.resolve('error' in next ? next : { data: next, error: null })
      }
      case 'revoke_user_sessions':
        return Promise.resolve({ data: { sessions: 1, push_subscriptions: 0 }, error: null })
      case 'record_security_event_result':
        return Promise.resolve({
          data:
            args.p_outcome === 'contained'
              ? { recorded: true, notify: NOTIFY }
              : { recorded: true },
          error: null,
        })
      case 'claim_due_messages': {
        const next = this.batches.shift() ?? { items: [], more: false }
        return Promise.resolve('error' in next ? next : { data: next, error: null })
      }
      case 'record_send_result':
        return Promise.resolve({ data: true, error: null })
      case 'record_dispatch_run':
        return Promise.resolve({ data: 1, error: null })
      default:
        return Promise.reject(new Error(`unexpected rpc ${fn}`))
    }
  }

  called(fn: string): Args[] {
    return this.calls.filter((call) => call.fn === fn).map((call) => call.args)
  }

  /** `fn` or `fn:outcome`, in call order. */
  steps(): string[] {
    return this.calls.map(({ fn, args }) =>
      typeof args.p_outcome === 'string' ? `${fn}:${args.p_outcome}` : fn,
    )
  }
}

type Harness = {
  db: FakeDb
  runtime: DispatchRuntime
  pushes: OneSignalPushPayload[]
  sms: string[]
  emails: EmailSendRequest[]
  deleted: string[]
  logs: Array<{ event: string; fields: Readonly<Record<string, LogValue>> }>
}

function harness(db = new FakeDb(), env: DispatchEnv = LOCAL_ENV): Harness {
  const pushes: OneSignalPushPayload[] = []
  const sms: string[] = []
  const emails: EmailSendRequest[] = []
  const deleted: string[] = []
  const logs: Harness['logs'] = []
  const factors: FactorsAdminPort = {
    deleteFactor: (_userId, factorId) => {
      deleted.push(factorId)
      db.calls.push({ fn: 'deleteFactor', args: {} })
      return Promise.resolve({ ok: true })
    },
  }
  const runtime = buildDispatchRuntime(env, {
    createRpc: () => db.rpc,
    createFactors: () => factors,
    log: (event, fields) => logs.push({ event, fields }),
    providerLog: (line) => sms.push(line),
    pushLog: () => {},
    pushRecord: (payload) => pushes.push(payload),
    emailLog: () => {},
    emailRecord: (request) => emails.push(request),
    fetch: () => Promise.reject(new Error('no network in tests')),
  })
  return { db, runtime, pushes, sms, emails, deleted, logs }
}

function request(
  body: unknown = { source: 'nudge' },
  headers: Record<string, string> = { [DISPATCH_SECRET_HEADER]: SECRET },
  method = 'POST',
): Request {
  return new Request('http://kong:8000/functions/v1/dispatch', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}

async function dispatch(h: Harness, req: Request = request(), now?: () => number) {
  const response = await handleDispatch(req, h.runtime, now ? { now } : {})
  return { response, body: (await response.json()) as Record<string, unknown> }
}

describe('dispatch: before any work', () => {
  it('answers 405 to anything but POST', async () => {
    const h = harness()
    const { response } = await dispatch(h, request(null, {}, 'GET'))
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('POST')
    expect(h.db.calls).toEqual([])
  })

  it('answers 500 not_configured to every request when the configuration is refused', async () => {
    for (const env of [
      { ...LOCAL_ENV, DISPATCH_SECRET: undefined },
      { ...LOCAL_ENV, DISPATCH_SECRET: '' },
      { ...LOCAL_ENV, DISPATCH_SECRET: 'env(DISPATCH_SECRET)' },
      { ...LOCAL_ENV, PUSH_PROVIDER: undefined },
      // 1.9: no security event is contained without its emails (fail closed).
      { ...LOCAL_ENV, EMAIL_PROVIDER: undefined },
      { ...LOCAL_ENV, SUPPORT_EMAIL: '' },
    ]) {
      const h = harness(new FakeDb(), env)
      // Even with the (local) secret in the header: an empty configured secret accepts nothing.
      const { response, body } = await dispatch(h)
      expect(response.status).toBe(500)
      expect(body).toEqual({
        error: { code: 'not_configured', message: 'The dispatch function is not configured.' },
      })
      expect(h.db.calls).toEqual([])
    }
  })

  it('answers 403 without the secret header or with a wrong one', async () => {
    const h = harness()
    const attempts: Array<Record<string, string>> = [
      {},
      { [DISPATCH_SECRET_HEADER]: '' },
      { [DISPATCH_SECRET_HEADER]: `${SECRET}x` },
      { [DISPATCH_SECRET_HEADER]: SECRET.slice(0, -1) },
      { 'x-anaklo-proxy-secret': SECRET },
      { Authorization: `Bearer ${SECRET}` },
    ]
    for (const headers of attempts) {
      const { response, body } = await dispatch(h, request({ source: 'nudge' }, headers))
      expect(response.status).toBe(403)
      expect(body).toEqual({ error: { code: 'forbidden', message: 'Forbidden.' } })
    }
    expect(h.db.calls).toEqual([])
  })

  it('accepts only { source: nudge | sweep | test | security } of at most 1 KB', async () => {
    const h = harness()
    for (const body of [
      {},
      { source: 'cron' },
      { source: 'nudge', ids: [crypto.randomUUID()] },
      'not json',
      [],
    ]) {
      const { response } = await dispatch(h, request(body))
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    const large = await dispatch(
      h,
      request({ source: 'nudge', pad: 'x'.repeat(DISPATCH_MAX_BODY_BYTES) }),
    )
    expect(large.response.status).toBe(413)
    expect(h.db.calls).toEqual([])
    for (const source of ['nudge', 'sweep', 'test', 'security']) {
      expect((await dispatch(h, request({ source }))).response.status).toBe(200)
    }
  })
})

describe('dispatch: rounds', () => {
  it('claims batches of 5 until more is false, sends SMS and push, records one run', async () => {
    const batch1 = [smsItem(), pushItem(), smsItem('booking_confirmed'), pushItem(), smsItem()]
    const batch2 = [pushItem('push_booking_cancelled'), smsItem('cancelled_by_business')]
    const h = harness(
      new FakeDb([
        { items: batch1, more: true },
        { items: batch2, more: false },
      ]),
    )
    const { response, body } = await dispatch(h, request({ source: 'sweep' }))

    expect(response.status).toBe(200)
    expect(body).toEqual({
      rounds: 2,
      claimed: 7,
      sent: 7,
      failed: 0,
      rejected: 0,
      unknown: 0,
      security: NO_SECURITY,
    })
    expect(h.db.called('claim_due_messages')).toEqual([{ p_limit: 5 }, { p_limit: 5 }])
    expect(h.db.called('record_send_result')).toHaveLength(7)
    expect(h.sms).toHaveLength(4)
    expect(h.pushes).toHaveLength(3)
    expect(h.pushes.every((p) => p.include_subscription_ids.join() === DEVICE)).toBe(true)
    const runs = h.db.called('record_dispatch_run')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ p_ok: true, p_rows: 7, p_error: null })
    expect(Number.isNaN(Date.parse(String(runs[0]?.p_started_at)))).toBe(false)
  })

  it('writes its heartbeat even when nothing is due', async () => {
    const h = harness()
    const { body } = await dispatch(h, request({ source: 'sweep' }))
    expect(body).toEqual({
      rounds: 1,
      claimed: 0,
      sent: 0,
      failed: 0,
      rejected: 0,
      unknown: 0,
      security: NO_SECURITY,
    })
    expect(h.db.called('record_dispatch_run')).toEqual([
      expect.objectContaining({ p_ok: true, p_rows: 0, p_error: null }),
    ])
  })

  it('stops after 5 rounds while more stays true (the sweep takes the rest)', async () => {
    const full = () => ({ items: [pushItem()], more: true })
    const h = harness(new FakeDb(Array.from({ length: 8 }, full)))
    const { body } = await dispatch(h)
    expect(body).toMatchObject({ rounds: 5, claimed: 5, sent: 5 })
    expect(h.db.called('claim_due_messages')).toHaveLength(5)
    expect(h.db.called('record_dispatch_run')).toHaveLength(1)
  })

  it('starts no round after 25 s', async () => {
    let clock = 1_000_000
    const h = harness(
      new FakeDb(Array.from({ length: 5 }, () => ({ items: [smsItem()], more: true }))),
    )
    h.db.overrides.set('record_send_result', () => {
      clock += DISPATCH_TIME_BUDGET_MS / 2 // each send "takes" 12.5 s
      return { data: true, error: null }
    })
    const { body } = await dispatch(h, request(), () => clock)
    expect(body).toMatchObject({ rounds: 2, claimed: 2 })
  })

  it('records ok=false with the SQLSTATE when a claim fails, keeping what it sent', async () => {
    const h = harness(
      new FakeDb([
        { items: [smsItem(), pushItem()], more: true },
        { data: null, error: { code: '40001', message: 'could not serialize access' } },
      ]),
    )
    const { response, body } = await dispatch(h)
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ rounds: 1, claimed: 2, sent: 2 })
    expect(h.db.called('record_dispatch_run')).toEqual([
      expect.objectContaining({ p_ok: false, p_rows: 2, p_error: '40001' }),
    ])
  })

  it('records ok=false when the claim answer does not match the contract', async () => {
    const h = harness()
    h.db.overrides.set('claim_due_messages', () => ({ data: [smsItem()], error: null }))
    const { body } = await dispatch(h)
    expect(body).toMatchObject({ rounds: 0, claimed: 0 })
    expect(h.db.called('record_dispatch_run')).toEqual([
      expect.objectContaining({ p_ok: false, p_error: 'invalid_claim' }),
    ])
  })

  it('counts failed, rejected and unknown sends', async () => {
    const bad = { ...pushItem(), push_targets: [] } // no OneSignal device → rejected
    const broken = { ...smsItem(), manage_token: null } // reminder without its link → failed
    const h = harness(new FakeDb([{ items: [bad, broken, smsItem()], more: false }]))
    const { body } = await dispatch(h)
    expect(body).toEqual({
      rounds: 1,
      claimed: 3,
      sent: 1,
      failed: 1,
      rejected: 1,
      unknown: 0,
      security: NO_SECURITY,
    })
  })

  it('answers even when the heartbeat cannot be recorded', async () => {
    const h = harness()
    h.db.overrides.set('record_dispatch_run', () => ({
      data: null,
      error: { code: '22023', message: 'p_started_at out of range' },
    }))
    const { response } = await dispatch(h)
    expect(response.status).toBe(200)
    expect(h.logs.map((line) => line.event)).toContain('dispatch_run_not_recorded')
  })

  it('answers and logs counts and codes only: no phone, token, device or name', async () => {
    const h = harness(new FakeDb([{ items: [smsItem(), pushItem()], more: false }]))
    const { body } = await dispatch(h)
    const out = JSON.stringify({ body, logs: h.logs })
    for (const secret of [PHONE, TOKEN, DEVICE, 'Γιώργος', 'Νίκος', 'Κουρείο', SECRET]) {
      expect(out, secret).not.toContain(secret)
    }
    expect(h.logs.find((line) => line.event === 'dispatch_run')?.fields).toMatchObject({
      source: 'nudge',
      rounds: 1,
      sent: 2,
      ok: true,
    })
  })
})

describe('dispatch: the security phase (contract 1.9 §3.2)', () => {
  it('runs first: contains and notifies, then the message round sends the owners push', async () => {
    const db = new FakeDb([{ items: [securityPushItem()], more: false }])
    db.events.push({ items: [securityEvent()], more: true })
    const h = harness(db)
    const { response, body } = await dispatch(h, request({ source: 'security' }))

    expect(response.status).toBe(200)
    expect(h.db.steps()).toEqual([
      'claim_security_events',
      'deleteFactor',
      'revoke_user_sessions',
      'record_security_event_result:contained',
      'record_security_event_result:notified',
      'claim_security_events',
      'claim_due_messages',
      'record_send_result:sent',
      'record_dispatch_run',
    ])
    expect(h.deleted).toEqual([FACTOR])
    // Emails to the member and the owner, through the fake email sender.
    expect(h.emails.map((email) => email.to)).toEqual([
      'manager@demo-barber.test',
      'owner@demo-barber.test',
    ])
    // The owner's push of the same run: the business only, to the owner's device only.
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0]?.include_subscription_ids).toEqual([OWNER_DEVICE])
    expect(h.pushes[0]?.headings.el).toBe('Ειδοποίηση ασφαλείας')
    expect(h.pushes[0]?.contents.el).toBe(
      'Κουρείο Demo: μια συσκευή κωδικών άλλαξε χωρίς έγκριση. Δες το email σου.',
    )
    expect(h.pushes[0]?.url).toBe('http://localhost:5173/app/settings/members')
    expect(JSON.stringify(h.pushes)).not.toContain('manager@')

    expect(body).toEqual({
      rounds: 1,
      claimed: 1,
      sent: 1,
      failed: 0,
      rejected: 0,
      unknown: 0,
      security: { claimed: 1, contained: 1, notified: 1, failed: 0 },
    })
    // Rows = messages sent + events notified.
    expect(h.db.called('record_dispatch_run')).toEqual([
      expect.objectContaining({ p_ok: true, p_rows: 2, p_error: null }),
    ])
  })

  it('records ok=false when the security claim fails, and the message rounds still run', async () => {
    const db = new FakeDb([{ items: [smsItem()], more: false }])
    db.events.push({ data: null, error: { code: '42883', message: 'function does not exist' } })
    const h = harness(db)
    const { response, body } = await dispatch(h)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ rounds: 1, claimed: 1, sent: 1, security: NO_SECURITY })
    expect(h.sms).toHaveLength(1)
    expect(h.db.called('record_dispatch_run')).toEqual([
      expect.objectContaining({ p_ok: false, p_rows: 1, p_error: '42883' }),
    ])
  })

  it('keeps the first error code when both phases fail', async () => {
    const db = new FakeDb([{ data: null, error: { code: '40001', message: 'serialize' } }])
    db.events.push({ data: null, error: { code: '42883', message: 'function does not exist' } })
    const h = harness(db)
    await dispatch(h)
    expect(h.db.called('record_dispatch_run')).toEqual([
      expect.objectContaining({ p_ok: false, p_error: '42883' }),
    ])
  })

  it('a contain_failed event sends nothing and does not fail the run', async () => {
    const db = new FakeDb()
    db.events.push({ items: [securityEvent()], more: true })
    db.overrides.set('revoke_user_sessions', () => ({
      data: null,
      error: { code: '57014', message: 'canceling statement' },
    }))
    const h = harness(db)
    const { body } = await dispatch(h)
    expect(h.emails).toEqual([])
    expect(body).toMatchObject({ security: { claimed: 1, contained: 0, notified: 0, failed: 1 } })
    expect(h.db.called('record_dispatch_run')).toEqual([
      expect.objectContaining({ p_ok: true, p_rows: 0, p_error: null }),
    ])
  })

  it('logs the security counts, never an email, a user id or a factor id', async () => {
    const db = new FakeDb()
    db.events.push({ items: [securityEvent('factor_removed_unauthorized')], more: true })
    const h = harness(db)
    const { body } = await dispatch(h)
    const out = JSON.stringify({ body, logs: h.logs })
    for (const secret of [MEMBER, FACTOR, 'manager@', 'owner@', 'support@example.com', 'Κουρείο']) {
      expect(out, secret).not.toContain(secret)
    }
    expect(h.deleted).toEqual([])
    expect(h.logs.find((line) => line.event === 'dispatch_run')?.fields).toMatchObject({
      security_claimed: 1,
      security_contained: 1,
      security_notified: 1,
      security_failed: 0,
      ok: true,
    })
  })
})

describe('buildDispatchRuntime (contract 1.5 §3.5)', () => {
  function problems(env: DispatchEnv): unknown {
    const logs: Array<{ event: string; fields: Readonly<Record<string, LogValue>> }> = []
    const runtime = buildDispatchRuntime(env, {
      createRpc: () => new FakeDb().rpc,
      createFactors: () => ({ deleteFactor: () => Promise.resolve({ ok: true }) }),
      log: (event, fields) => logs.push({ event, fields }),
    })
    expect(runtime.services).toBeNull()
    expect(runtime.secret).toBeNull()
    return logs.find((line) => line.event === 'not_configured')?.fields.problems
  }

  it('builds the senders from a valid local environment', () => {
    const h = harness()
    expect(h.runtime.secret).toBe(SECRET)
    expect(h.runtime.services?.provider.name).toBe('fake')
    expect(h.runtime.services?.pushProvider.name).toBe('fake')
    expect(h.runtime.services?.emailProvider.name).toBe('fake')
    expect(h.runtime.services?.supportEmail).toBe('support@example.com')
  })

  it('needs a DISPATCH_SECRET of at least 32 characters', () => {
    expect(problems({ ...LOCAL_ENV, DISPATCH_SECRET: undefined })).toContain(
      'DISPATCH_SECRET: required (the same value as Vault dispatch_secret)',
    )
    expect(problems({ ...LOCAL_ENV, DISPATCH_SECRET: 'x'.repeat(31) })).toContain(
      'DISPATCH_SECRET: at least 32 characters',
    )
    expect(
      harness(new FakeDb(), { ...LOCAL_ENV, DISPATCH_SECRET: 'y'.repeat(32) }).runtime.secret,
    ).toBe('y'.repeat(32))
  })

  it('refuses the local secret and the fake senders in prod (ANAKLO_ENV unset = prod)', () => {
    const found = problems({ ...LOCAL_ENV, ANAKLO_ENV: undefined })
    expect(found).toContain(
      'DISPATCH_SECRET: the local value is refused when ANAKLO_ENV is prod (or unset)',
    )
    expect(found).toContain('SMS_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)')
    expect(found).toContain('PUSH_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)')
    expect(found).toContain('EMAIL_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)')
    expect(found).toContain(
      'SUPPORT_EMAIL: an @example.com address is refused when ANAKLO_ENV is prod',
    )
  })

  it('never reads the OTP test variables (dispatch sends no OTP)', () => {
    const env = { ...LOCAL_ENV, OTP_TEST_NUMBERS: 'not-a-number', OTP_TEST_CODE: 'x' }
    expect(harness(new FakeDb(), env).runtime.services).not.toBeNull()
  })

  it('names variables, never values', () => {
    const found = JSON.stringify(
      problems({ ...LOCAL_ENV, DISPATCH_SECRET: 'short-secret-value', SITE_HOST: 'HTTPS://X' }),
    )
    expect(found).not.toContain('short-secret-value')
    expect(found).not.toContain('HTTPS://X')
  })
})
