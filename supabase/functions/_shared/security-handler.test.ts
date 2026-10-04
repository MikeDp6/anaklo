// @vitest-environment node
//
// The security phase of `dispatch` (contract 1.9 §3.2, the Nous copy of 1.9b §3.2) against an
// in-memory stand-in of
// `claim_security_events`, `record_security_event_result` and `revoke_user_sessions`, a fake Auth
// admin port and the real fake email sender. The SQL (leases, the system grant, the push rows,
// notify_unknown) is pgTAP `16_health`; the whole chain on the local stack is
// tests/db/security-detection.test.ts.
import { describe, expect, it } from 'vitest'
import type { LogValue, Rpc, RpcResult } from './booking-rpc.ts'
import { createFakeEmailProvider, type EmailSendRequest } from './email-provider.ts'
import type { DeleteFactorOutcome, FactorsAdminPort } from './member-functions.ts'
import {
  handleSecurityEvents,
  SECURITY_MAX_EVENTS,
  SECURITY_TIME_BUDGET_MS,
  type SecurityServices,
} from './security-handler.ts'

const USER = '3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'
const FACTOR = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d'
const SUPPORT = 'support@example.com'
const ACCOUNT = 'manager@demo-barber.test'
const OWNER_EL = 'owner@demo-barber.test'
const OWNER_EN = 'owner@other-shop.test'
const DETECTED = '2026-10-03T18:07:12.345678+00:00'

type Args = Readonly<Record<string, unknown>>
type Kind = 'factor_added_unauthorized' | 'factor_removed_unauthorized'

function claimed(
  kind: Kind = 'factor_added_unauthorized',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    kind,
    user_id: USER,
    factor_id: FACTOR,
    attempts: 1,
    ...overrides,
  }
}

/**
 * The bundle of `queue_security_notifications`: user first, then owners (D13); from 0012 also the
 * account's address and its businesses in the event's order (contract 1.9b §2.4.5).
 */
function bundle(kind: Kind = 'factor_added_unauthorized') {
  return {
    kind,
    detected_at: DETECTED,
    push_queued: 2,
    account_email: ACCOUNT,
    businesses: [
      { name: 'Κουρείο Demo', slug: 'demo-barber' },
      { name: 'Other Shop', slug: 'other-shop' },
    ],
    emails: [
      {
        audience: 'user',
        to: ACCOUNT,
        locale: 'en',
        timezone: 'Europe/London',
        business_name: null,
        account_email: ACCOUNT,
      },
      {
        audience: 'owner',
        to: OWNER_EN,
        locale: 'en',
        timezone: 'Europe/London',
        business_name: 'Other Shop',
        account_email: ACCOUNT,
      },
      {
        audience: 'owner',
        to: OWNER_EL,
        locale: 'el',
        timezone: 'Europe/Athens',
        business_name: 'Κουρείο Demo',
        account_email: ACCOUNT,
      },
    ],
  }
}

type Step = string

class Fake {
  readonly steps: Step[] = []
  readonly calls: Array<{ fn: string; args: Args }> = []
  readonly claims: Array<RpcResult | { items: unknown[]; more: boolean }>
  readonly overrides = new Map<string, (args: Args) => RpcResult | Promise<RpcResult>>()
  deleteAnswer: DeleteFactorOutcome | Error = { ok: true }
  readonly deleted: Array<{ userId: string; factorId: string }> = []
  readonly emails: EmailSendRequest[] = []
  readonly logs: Array<{ event: string; fields: Readonly<Record<string, LogValue>> }> = []
  notify: unknown = bundle()
  clock = 1_000_000

  constructor(claims: Array<RpcResult | { items: unknown[]; more: boolean }> = []) {
    this.claims = [...claims]
  }

  readonly rpc: Rpc = async (fn, args) => {
    this.calls.push({ fn, args })
    const outcome = typeof args.p_outcome === 'string' ? `:${args.p_outcome}` : ''
    this.steps.push(`${fn}${outcome}`)
    const override = this.overrides.get(fn)
    if (override) return override(args)
    switch (fn) {
      case 'claim_security_events': {
        const next = this.claims.shift() ?? { items: [], more: false }
        return 'error' in next ? next : { data: next, error: null }
      }
      case 'revoke_user_sessions':
        return { data: { sessions: 1, push_subscriptions: 0 }, error: null }
      case 'record_security_event_result':
        return args.p_outcome === 'contained'
          ? { data: { recorded: true, notify: this.notify }, error: null }
          : { data: { recorded: true }, error: null }
      default:
        throw new Error(`unexpected rpc ${fn}`)
    }
  }

  readonly factors: FactorsAdminPort = {
    deleteFactor: (userId, factorId) => {
      this.steps.push('deleteFactor')
      this.deleted.push({ userId, factorId })
      return this.deleteAnswer instanceof Error
        ? Promise.reject(this.deleteAnswer)
        : Promise.resolve(this.deleteAnswer)
    },
  }

  services(overrides: Partial<SecurityServices> = {}): SecurityServices {
    return {
      rpc: this.rpc,
      factors: this.factors,
      emailProvider: createFakeEmailProvider({
        env: 'local',
        log: () => {},
        record: (request) => {
          this.steps.push('send')
          this.emails.push(request)
        },
      }),
      supportEmail: SUPPORT,
      ...overrides,
    }
  }

  run(overrides: Partial<SecurityServices> = {}) {
    return handleSecurityEvents(
      this.services(overrides),
      (event, fields) => this.logs.push({ event, fields }),
      () => this.clock,
    )
  }

  called(fn: string): Args[] {
    return this.calls.filter((call) => call.fn === fn).map((call) => call.args)
  }

  records(outcome: string): Args[] {
    return this.called('record_security_event_result').filter((a) => a.p_outcome === outcome)
  }
}

function batch(...items: unknown[]) {
  return { items, more: items.length > 0 }
}

describe('security phase: an added factor (contract 1.9 §3.2)', () => {
  it('claims → deletes the factor → revokes → contained → one email each and Nous → notified (4, 0)', async () => {
    const event = claimed()
    const fake = new Fake([batch(event)])
    const result = await fake.run()

    expect(fake.steps).toEqual([
      'claim_security_events',
      'deleteFactor',
      'revoke_user_sessions',
      'record_security_event_result:contained',
      'send',
      'send',
      'send',
      'send',
      'record_security_event_result:notified',
      'claim_security_events',
    ])
    expect(fake.called('claim_security_events')[0]).toEqual({ p_limit: 1 })
    expect(fake.deleted).toEqual([{ userId: USER, factorId: FACTOR }])
    expect(fake.called('revoke_user_sessions')).toEqual([{ p_user_id: USER }])
    expect(fake.records('contained')).toEqual([
      {
        p_id: event.id,
        p_lease_id: event.lease_id,
        p_outcome: 'contained',
        p_emails_sent: null,
        p_emails_failed: null,
        p_error: null,
      },
    ])
    expect(fake.records('notified')).toEqual([
      {
        p_id: event.id,
        p_lease_id: event.lease_id,
        p_outcome: 'notified',
        p_emails_sent: 4,
        p_emails_failed: 0,
        p_error: null,
      },
    ])
    expect(result).toEqual({
      summary: { claimed: 1, contained: 1, notified: 1, failed: 0 },
      ok: true,
      error: null,
    })
  })

  it('sends each email in its language and zone; the owner email names the account and the business', async () => {
    const event = claimed()
    const fake = new Fake([batch(event)])
    await fake.run()

    expect(fake.emails.map((email) => email.to)).toEqual([ACCOUNT, OWNER_EN, OWNER_EL, SUPPORT])
    expect(fake.emails.map((email) => email.idempotencyKey)).toEqual([
      `security:${event.id}:0`,
      `security:${event.id}:1`,
      `security:${event.id}:2`,
      `security:${event.id}:nous`,
    ])
    const [user, ownerEn, ownerEl, nous] = fake.emails
    // 18:07 UTC = 19:07 in London (BST) and 21:07 in Athens (EEST).
    expect(user?.subject).toBe('Anaklo: we removed an authenticator device added without approval')
    expect(user?.text).toContain(
      `On 03/10/2026 at 19:07 a new authenticator device was added to the account ${ACCOUNT}`,
    )
    expect(user?.text).toContain(SUPPORT)
    expect(ownerEn?.subject).toBe(
      "Anaklo · Other Shop: unapproved authenticator device on a member's account",
    )
    expect(ownerEn?.text).toContain(`the account ${ACCOUNT} of Other Shop`)
    expect(ownerEl?.subject).toBe(
      'Anaklo · Κουρείο Demo: συσκευή κωδικών χωρίς έγκριση σε λογαριασμό μέλους',
    )
    expect(ownerEl?.text).toContain(
      `Στις 03/10/2026 21:07 προστέθηκε μια νέα συσκευή κωδικών στον λογαριασμό ${ACCOUNT} του Κουρείο Demo`,
    )
    // The Nous copy: Greek, in UTC (18:07), whatever the businesses' zones.
    expect(nous?.subject).toBe('Anaklo · Nous: προστέθηκε συσκευή κωδικών χωρίς έγκριση')
    expect(nous?.text).toContain(`Στις 03/10/2026 18:07 UTC ο έλεγχος βρήκε`)
    for (const email of fake.emails) {
      expect(email.text).not.toContain(FACTOR)
      expect(email.subject).not.toContain(FACTOR)
      expect(email.text).not.toMatch(/https?:|www\./)
    }
  })

  it('treats 404 from deleteFactor as done (already gone: a repeated containment)', async () => {
    const fake = new Fake([batch(claimed())])
    fake.deleteAnswer = { ok: false, status: 404 }
    const result = await fake.run()
    expect(fake.records('contained')).toHaveLength(1)
    expect(fake.records('notified')).toHaveLength(1)
    expect(result.summary).toEqual({ claimed: 1, contained: 1, notified: 1, failed: 0 })
  })
})

describe('security phase: a removed factor', () => {
  it('never deletes anything: revoke → contained → emails → notified', async () => {
    const event = claimed('factor_removed_unauthorized')
    const fake = new Fake([batch(event)])
    fake.notify = bundle('factor_removed_unauthorized')
    const result = await fake.run()

    expect(fake.deleted).toEqual([])
    expect(fake.steps).toEqual([
      'claim_security_events',
      'revoke_user_sessions',
      'record_security_event_result:contained',
      'send',
      'send',
      'send',
      'send',
      'record_security_event_result:notified',
      'claim_security_events',
    ])
    expect(fake.emails[0]?.subject).toBe(
      'Anaklo: an authenticator device was removed without approval',
    )
    expect(fake.emails[2]?.text).toContain('αφαιρέθηκε μια συσκευή κωδικών από τον λογαριασμό')
    expect(fake.emails[3]?.to).toBe(SUPPORT)
    expect(fake.emails[3]?.subject).toBe('Anaklo · Nous: αφαιρέθηκε συσκευή κωδικών χωρίς έγκριση')
    expect(fake.emails[3]?.text).toContain('«Επικοινώνησε με τη Nous»')
    expect(fake.records('notified')).toEqual([
      expect.objectContaining({ p_emails_sent: 4, p_emails_failed: 0 }),
    ])
    expect(result.summary).toEqual({ claimed: 1, contained: 1, notified: 1, failed: 0 })
  })
})

describe('security phase: each event at most once', () => {
  it('sends nothing when contained is refused (another dispatcher holds the lease)', async () => {
    const fake = new Fake([batch(claimed())])
    fake.overrides.set('record_security_event_result', () => ({
      data: { recorded: false },
      error: null,
    }))
    const result = await fake.run()
    expect(fake.emails).toEqual([])
    expect(fake.records('notified')).toEqual([])
    expect(fake.logs.map((line) => line.event)).toContain('security_lease_lost')
    expect(result).toMatchObject({ ok: true, summary: { claimed: 1, contained: 0, notified: 0 } })
    // It goes on to the next claim.
    expect(fake.called('claim_security_events')).toHaveLength(2)
  })

  it('records contain_failed with the code and sends nothing when the delete fails', async () => {
    for (const answer of [
      { ok: false, status: 500 } as const,
      { ok: false, status: 0 } as const,
      new Error('boom'),
    ]) {
      const event = claimed()
      const fake = new Fake([batch(event), batch(claimed())])
      fake.deleteAnswer = answer
      const result = await fake.run()
      // The sessions still go, even though the delete failed.
      expect(fake.called('revoke_user_sessions')).toEqual([{ p_user_id: USER }])
      expect(fake.records('contain_failed')).toEqual([
        {
          p_id: event.id,
          p_lease_id: event.lease_id,
          p_outcome: 'contain_failed',
          p_emails_sent: null,
          p_emails_failed: null,
          p_error: 'factor_delete_failed',
        },
      ])
      expect(fake.records('contained')).toEqual([])
      expect(fake.emails).toEqual([])
      // The failed event is the oldest pending one: the phase ends, the next run retries it.
      expect(fake.called('claim_security_events')).toHaveLength(1)
      expect(result).toEqual({
        summary: { claimed: 1, contained: 0, notified: 0, failed: 1 },
        ok: true,
        error: null,
      })
    }
  })

  it('records contain_failed revoke_failed when the revoke errors or throws', async () => {
    for (const kind of ['factor_added_unauthorized', 'factor_removed_unauthorized'] as const) {
      for (const failure of ['error', 'throw'] as const) {
        const fake = new Fake([batch(claimed(kind))])
        fake.overrides.set('revoke_user_sessions', () => {
          if (failure === 'throw') throw new Error('network')
          return { data: null, error: { code: '57014', message: 'canceling statement' } }
        })
        await fake.run()
        expect(fake.records('contain_failed')[0]?.p_error).toBe('revoke_failed')
        expect(fake.emails).toEqual([])
      }
    }
  })

  it('keeps the first code when both the delete and the revoke fail', async () => {
    const fake = new Fake([batch(claimed())])
    fake.deleteAnswer = { ok: false, status: 502 }
    fake.overrides.set('revoke_user_sessions', () => ({
      data: null,
      error: { code: '08006', message: 'connection failure' },
    }))
    await fake.run()
    expect(fake.records('contain_failed')[0]?.p_error).toBe('factor_delete_failed')
  })

  it('a failing email is counted and never retried; the others still go; notified once', async () => {
    const fake = new Fake([batch(claimed())])
    let sends = 0
    const result = await fake.run({
      emailProvider: {
        name: 'scripted',
        send: (request) => {
          sends += 1
          if (request.to === OWNER_EN) return Promise.reject(new Error('smtp down'))
          fake.emails.push(request)
          return Promise.resolve({ ok: true, providerMessageId: `id-${sends}` })
        },
      },
    })
    expect(sends).toBe(4)
    expect(fake.emails.map((email) => email.to)).toEqual([ACCOUNT, OWNER_EL, SUPPORT])
    expect(fake.records('notified')).toEqual([
      expect.objectContaining({ p_emails_sent: 3, p_emails_failed: 1 }),
    ])
    expect(result.summary.notified).toBe(1)
  })

  it('counts every kind of email failure: failed, rejected, unknown, a bad entry, a bad zone', async () => {
    const fake = new Fake([batch(claimed())])
    const base = bundle()
    fake.notify = {
      ...base,
      emails: [
        ...base.emails,
        { ...base.emails[0], to: 'not-an-address' }, // the fake sender: failed invalid_recipient
        { ...base.emails[1], timezone: 'Mars/Olympus' }, // render_error
        { ...base.emails[2], business_name: null }, // an owner email without its business
        { audience: 'owner', to: OWNER_EL }, // off the contract
      ],
    }
    await fake.run()
    // The three good ones and the Nous copy.
    expect(fake.emails).toHaveLength(4)
    expect(fake.records('notified')).toEqual([
      expect.objectContaining({ p_emails_sent: 4, p_emails_failed: 4 }),
    ])
  })

  it('logs only when the notified record is refused (the lease ran out: never re-sent)', async () => {
    const fake = new Fake([batch(claimed())])
    fake.overrides.set('record_security_event_result', (args) =>
      args.p_outcome === 'contained'
        ? { data: { recorded: true, notify: bundle() }, error: null }
        : { data: { recorded: false }, error: null },
    )
    const result = await fake.run()
    expect(fake.emails).toHaveLength(4)
    expect(fake.records('notified')).toHaveLength(1)
    expect(fake.logs).toContainEqual(
      expect.objectContaining({
        event: 'security_lease_lost',
        fields: expect.objectContaining({ step: 'notified' }) as unknown,
      }),
    )
    expect(result).toMatchObject({ ok: true, summary: { contained: 1, notified: 0 } })
  })
})

describe('security phase: claims and limits', () => {
  it('makes no other call when nothing is pending', async () => {
    const fake = new Fake()
    const result = await fake.run()
    expect(fake.steps).toEqual(['claim_security_events'])
    expect(fake.deleted).toEqual([])
    expect(result).toEqual({
      summary: { claimed: 0, contained: 0, notified: 0, failed: 0 },
      ok: true,
      error: null,
    })
  })

  it('handles at most 5 events per run, one claim each', async () => {
    const fake = new Fake(Array.from({ length: 8 }, () => batch(claimed())))
    const result = await fake.run()
    expect(SECURITY_MAX_EVENTS).toBe(5)
    expect(fake.called('claim_security_events')).toHaveLength(5)
    expect(result.summary).toEqual({ claimed: 5, contained: 5, notified: 5, failed: 0 })
  })

  it('claims nothing new after 15 s', async () => {
    const fake = new Fake(Array.from({ length: 5 }, () => batch(claimed())))
    fake.overrides.set('revoke_user_sessions', () => {
      fake.clock += SECURITY_TIME_BUDGET_MS / 2 + 1 // each containment "takes" 7.5 s
      return { data: {}, error: null }
    })
    const result = await fake.run()
    expect(result.summary.claimed).toBe(2)
  })

  it('ends the phase with ok=false on a claim error, a throw or an answer off the contract', async () => {
    const cases: Array<[() => RpcResult | Promise<RpcResult>, string]> = [
      [() => ({ data: null, error: { code: '42501', message: 'permission denied' } }), '42501'],
      [() => Promise.reject(new Error('network')), 'claim_security_events_exception'],
      [() => ({ data: [claimed()], error: null }), 'invalid_claim'],
    ]
    for (const [answer, code] of cases) {
      const fake = new Fake()
      fake.overrides.set('claim_security_events', answer)
      const result = await fake.run()
      expect(result).toEqual({
        summary: { claimed: 0, contained: 0, notified: 0, failed: 0 },
        ok: false,
        error: code,
      })
      expect(fake.deleted).toEqual([])
      expect(fake.called('claim_security_events')).toHaveLength(1)
    }
  })

  it('releases an item off the contract as contain_failed invalid_claim, touching nothing', async () => {
    const bad = claimed('factor_added_unauthorized', { factor_id: 'not-a-uuid' })
    const fake = new Fake([batch(bad)])
    const result = await fake.run()
    expect(fake.deleted).toEqual([])
    expect(fake.called('revoke_user_sessions')).toEqual([])
    expect(fake.records('contain_failed')).toEqual([
      expect.objectContaining({ p_id: bad.id, p_lease_id: bad.lease_id, p_error: 'invalid_claim' }),
    ])
    expect(result).toEqual({
      summary: { claimed: 1, contained: 0, notified: 0, failed: 1 },
      ok: false,
      error: 'invalid_claim',
    })
  })

  it('stops (ok=false) when recording fails, or when the contained answer is unreadable', async () => {
    const recordError = new Fake([batch(claimed()), batch(claimed())])
    recordError.overrides.set('record_security_event_result', () => ({
      data: null,
      error: { code: '40001', message: 'could not serialize access' },
    }))
    const first = await recordError.run()
    expect(first).toMatchObject({ ok: false, error: '40001' })
    expect(recordError.emails).toEqual([])
    expect(recordError.called('claim_security_events')).toHaveLength(1)

    const unreadable = new Fake([batch(claimed())])
    unreadable.notify = { kind: 'factor_added_unauthorized' }
    const second = await unreadable.run()
    expect(second).toMatchObject({ ok: false, error: 'invalid_notify' })
    expect(unreadable.emails).toEqual([])
    expect(unreadable.records('notified')).toEqual([])
  })

  it('logs ids, kinds, steps and counts only: never a user id, an email, a factor id or a text', async () => {
    const fake = new Fake([batch(claimed()), batch(claimed('factor_removed_unauthorized'))])
    await fake.run()
    const logged = JSON.stringify(fake.logs)
    for (const secret of [
      USER,
      FACTOR,
      ACCOUNT,
      OWNER_EL,
      OWNER_EN,
      SUPPORT,
      'Κουρείο',
      'Other Shop',
      'Anaklo',
    ]) {
      expect(logged, secret).not.toContain(secret)
    }
    expect(fake.logs).toContainEqual({
      event: 'security_event',
      fields: expect.objectContaining({
        kind: 'factor_added_unauthorized',
        step: 'notify',
        outcome: 'notified',
        emails_sent: 4,
        emails_failed: 0,
        push_queued: 2,
      }) as unknown,
    })
  })
})

describe('security phase: the Nous copy (contract 1.9b §3.2)', () => {
  function nousEmails(fake: Fake) {
    return fake.emails.filter((email) => email.to === SUPPORT)
  }

  it('sends exactly one, after contained, to SUPPORT_EMAIL with its own key and the 0012 values', async () => {
    const event = claimed()
    const fake = new Fake([batch(event)])
    await fake.run()

    expect(nousEmails(fake)).toHaveLength(1)
    const [nous] = nousEmails(fake)
    expect(nous?.idempotencyKey).toBe(`security:${event.id}:nous`)
    // After the contained record, before the notified one.
    const sendAt = fake.steps.lastIndexOf('send')
    expect(fake.steps.indexOf('record_security_event_result:contained')).toBeLessThan(
      fake.steps.indexOf('send'),
    )
    expect(sendAt).toBeLessThan(fake.steps.indexOf('record_security_event_result:notified'))
    expect(nous?.subject).toBe('Anaklo · Nous: προστέθηκε συσκευή κωδικών χωρίς έγκριση')
    expect(nous?.text).toBe(
      [
        `Στις 03/10/2026 18:07 UTC ο έλεγχος βρήκε μια συσκευή κωδικών που προστέθηκε χωρίς έγκριση στον λογαριασμό ${ACCOUNT}.`,
        'Επιχειρήσεις όπου ο λογαριασμός είναι ιδιοκτήτης ή διαχειριστής: Κουρείο Demo (demo-barber), Other Shop (other-shop).',
        'Τι έγινε αυτόματα: η συσκευή αφαιρέθηκε, ο λογαριασμός αποσυνδέθηκε από όλες τις συσκευές και στάλθηκε email στον λογαριασμό και σε 2 ιδιοκτήτες.',
        `Τι κάνεις: runbook security-event.md, αναφορά ${event.id}. Επικοινωνία μόνο από κανάλι που ήδη γνωρίζουμε (το τηλέφωνο του καταστήματος από τα στοιχεία μας), ποτέ με στοιχεία από εισερχόμενο μήνυμα.`,
      ].join('\n\n'),
    )
    // Never a secret, a code, a link, a factor id or the user id (the address is there).
    expect(nous?.text).not.toContain(FACTOR)
    expect(nous?.text).not.toContain(USER)
    expect(nous?.text).not.toMatch(/https?:|www\./)
  })

  it('keeps the businesses in the bundle order and counts only the owner items', async () => {
    const fake = new Fake([batch(claimed('factor_removed_unauthorized'))])
    const base = bundle('factor_removed_unauthorized')
    fake.notify = {
      ...base,
      businesses: [
        { name: 'Zeta', slug: 'zeta' },
        { name: 3, slug: 'bad' }, // off the contract: skipped
        'not-an-object',
        null,
        { name: 'Alpha', slug: 'alpha' },
      ],
      emails: [
        ...base.emails,
        { ...base.emails[1], to: OWNER_EL }, // a third owner item
        { audience: 'owner', to: OWNER_EL }, // off the contract: not counted
      ],
    }
    await fake.run()
    const [nous] = nousEmails(fake)
    expect(nous?.text).toContain(
      'Επιχειρήσεις όπου ο λογαριασμός είναι ιδιοκτήτης ή διαχειριστής: Zeta (zeta), Alpha (alpha).',
    )
    expect(nous?.text).toContain('σε 3 ιδιοκτήτες')
    expect(nous?.text).toContain('«Επικοινώνησε με τη Nous»')
  })

  it('names the user id when the account has no address, and "-" when there are no businesses', async () => {
    const event = claimed()
    const fake = new Fake([batch(event)])
    fake.notify = { ...bundle(), account_email: null, businesses: [], emails: [] }
    const result = await fake.run()
    // No other email (no address): the Nous copy alone.
    expect(fake.emails.map((email) => email.to)).toEqual([SUPPORT])
    expect(fake.emails[0]?.text).toContain(`στον λογαριασμό ${USER}.`)
    expect(fake.emails[0]?.text).toContain(
      'Επιχειρήσεις όπου ο λογαριασμός είναι ιδιοκτήτης ή διαχειριστής: -.',
    )
    expect(fake.emails[0]?.text).toContain('σε 0 ιδιοκτήτες')
    expect(fake.records('notified')).toEqual([
      expect.objectContaining({ p_emails_sent: 1, p_emails_failed: 0 }),
    ])
    expect(result.summary).toEqual({ claimed: 1, contained: 1, notified: 1, failed: 0 })
    // The user id is in the Nous email only, never in a log.
    expect(JSON.stringify(fake.logs)).not.toContain(USER)
  })

  it('still goes to Nous from a database without 0012 (no account_email, no businesses)', async () => {
    const fake = new Fake([batch(claimed())])
    const { kind, detected_at, push_queued, emails } = bundle()
    fake.notify = { kind, detected_at, push_queued, emails }
    await fake.run()
    expect(fake.emails.map((email) => email.to)).toEqual([ACCOUNT, OWNER_EN, OWNER_EL, SUPPORT])
    const [nous] = nousEmails(fake)
    expect(nous?.text).toContain(`στον λογαριασμό ${USER}.`)
    expect(nous?.text).toContain(': -.')
    expect(nous?.text).toContain('σε 2 ιδιοκτήτες')
    expect(fake.records('notified')).toEqual([
      expect.objectContaining({ p_emails_sent: 4, p_emails_failed: 0 }),
    ])
  })

  it('goes alone when the bundle has no email (sole owner): notified (1, 0)', async () => {
    const fake = new Fake([batch(claimed())])
    fake.notify = { ...bundle(), emails: [] }
    await fake.run()
    expect(fake.emails.map((email) => email.idempotencyKey)).toEqual([
      expect.stringMatching(/^security:[0-9a-f-]{36}:nous$/),
    ])
    expect(nousEmails(fake)[0]?.text).toContain(`στον λογαριασμό ${ACCOUNT}.`)
    expect(fake.records('notified')).toEqual([
      expect.objectContaining({ p_emails_sent: 1, p_emails_failed: 0 }),
    ])
  })

  it('a Nous copy that throws or is refused is counted, never retried; the others still go', async () => {
    for (const answer of ['throw', 'rejected', 'failed'] as const) {
      const fake = new Fake([batch(claimed())])
      const attempts: string[] = []
      const result = await fake.run({
        emailProvider: {
          name: 'scripted',
          send: (request) => {
            attempts.push(request.to)
            if (request.to !== SUPPORT) {
              fake.emails.push(request)
              return Promise.resolve({ ok: true, providerMessageId: 'id' })
            }
            if (answer === 'throw') return Promise.reject(new Error('smtp down'))
            return Promise.resolve({ ok: false, outcome: answer, error: 'refused' })
          },
        },
      })
      expect(
        attempts.filter((to) => to === SUPPORT),
        answer,
      ).toHaveLength(1)
      expect(fake.emails.map((email) => email.to)).toEqual([ACCOUNT, OWNER_EN, OWNER_EL])
      expect(fake.records('notified')).toEqual([
        expect.objectContaining({ p_emails_sent: 3, p_emails_failed: 1 }),
      ])
      expect(result.summary).toEqual({ claimed: 1, contained: 1, notified: 1, failed: 0 })
      expect(fake.logs).toContainEqual({
        event: 'security_email',
        fields: expect.objectContaining({
          index: null,
          audience: 'nous',
          outcome: answer === 'throw' ? 'unknown' : answer,
        }) as unknown,
      })
    }
  })

  it('is never sent when containment failed, the lease was lost or the contained record failed', async () => {
    const scenarios: Array<[string, (fake: Fake) => void]> = [
      ['contain_failed', (fake) => (fake.deleteAnswer = { ok: false, status: 500 })],
      [
        'lease lost',
        (fake) =>
          fake.overrides.set('record_security_event_result', () => ({
            data: { recorded: false },
            error: null,
          })),
      ],
      ['unreadable contained', (fake) => (fake.notify = { kind: 'factor_added_unauthorized' })],
      [
        'contained record error',
        (fake) =>
          fake.overrides.set('record_security_event_result', () => ({
            data: null,
            error: { code: '40001', message: 'could not serialize access' },
          })),
      ],
    ]
    for (const [name, arrange] of scenarios) {
      const fake = new Fake([batch(claimed())])
      arrange(fake)
      await fake.run()
      expect(fake.emails, name).toEqual([])
      expect(fake.steps, name).not.toContain('send')
      expect(fake.records('notified'), name).toEqual([])
    }
  })

  it('logs audience nous with no index, never the address, the user id or the factor id', async () => {
    const fake = new Fake([batch(claimed()), batch(claimed('factor_removed_unauthorized'))])
    fake.notify = { ...bundle(), account_email: null }
    await fake.run()
    const nousLines = fake.logs.filter((line) => line.fields.audience === 'nous')
    expect(nousLines).toHaveLength(2)
    for (const line of nousLines) {
      expect(line).toEqual({
        event: 'security_email',
        fields: {
          id: expect.any(String) as unknown,
          index: null,
          audience: 'nous',
          outcome: 'sent',
          error: null,
        },
      })
    }
    const logged = JSON.stringify(fake.logs)
    for (const secret of [USER, FACTOR, ACCOUNT, SUPPORT, 'demo-barber', 'Other Shop', 'Nous:']) {
      expect(logged, secret).not.toContain(secret)
    }
  })
})
