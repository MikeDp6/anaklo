import { z } from 'zod/mini'
import { Id, Instant } from './booking-schemas.ts'
import type { Log, LogValue, Rpc } from './booking-rpc.ts'
import { formatInZone } from './dates.ts'
import { Locale, SecurityEmailAudience, SecurityEventKind } from './domain.ts'
import type { EmailProvider } from './email-provider.ts'
import type { FactorsAdminPort } from './member-functions.ts'
import {
  renderSecurityEmail,
  SECURITY_NOUS_LOCALE,
  SECURITY_NOUS_TIME_ZONE,
  securityEmailKey,
  type SecurityEmailValues,
} from './security-email-templates.ts'

/**
 * The security phase of `dispatch` (contract 1.9 §3.2): the reaction to `private.security_events`,
 * the authenticator-device changes the detector (0011, every 5′) found without a grant. Pure
 * (ADR-0002 §3): the database (`rpc`), the Auth admin port, the email sender and the clock come
 * in from `dispatch/index.ts`.
 *
 * Per event, claimed ONE at a time with a 120 s lease (`claim_security_events`, which also writes
 * the `system` remove grant of an added factor before anything is deleted):
 *   1. contain: an ADDED factor is deleted (`auth.admin.mfa.deleteFactor`; 404 = already gone);
 *      for both kinds every session of the user is revoked (`revoke_user_sessions`). A REMOVED
 *      factor is never re-created (its secret is gone). Containment is idempotent and repeated
 *      until it succeeds: a failure is recorded `contain_failed` and the next run claims it again.
 *   2. `contained` (current lease only): the database queues the owners' push in `messages_log`
 *      in the same transaction and returns the email bundle. `{ recorded: false }` = another
 *      dispatcher has the event: nothing is sent.
 *   3. notify: every email of the bundle AND the Nous copy (contract 1.9b §3.2: one email to
 *      `SUPPORT_EMAIL`, Greek, UTC, key `security:<event id>:nous`, also when the bundle has no
 *      email) once, in parallel; a failed email is counted, never retried (D16).
 *   4. `notified` with the counts (the Nous copy included, contract 1.9b B4).
 * Notifications go AT MOST ONCE: they are sent only after `contained` was recorded, and a
 * dispatcher that dies while notifying leaves the event to be closed `notify_unknown` by the next
 * claim, never re-sent.
 *
 * Logs carry event ids, kinds, steps, outcome codes and counts only: never a user id, an email
 * address, a factor id or a text.
 */

/** Events per run; a claim takes one at a time. */
export const SECURITY_MAX_EVENTS = 5
/** No new claim after this long (the message rounds follow, within the 25 s of the run). */
export const SECURITY_TIME_BUDGET_MS = 15_000
/** `03/10/2026`, `21:07` in the business's time zone and language (contract 1.9 §3.2). */
export const SECURITY_EMAIL_DATE_PATTERN = 'dd/MM/yyyy'
export const SECURITY_EMAIL_TIME_PATTERN = 'HH:mm'
/** CHECK of `security_events.emails_sent` / `emails_failed`. */
const MAX_EMAIL_COUNT = 100

export type SecurityServices = {
  readonly rpc: Rpc
  /** service_role: `auth.admin.mfa.deleteFactor`. */
  readonly factors: FactorsAdminPort
  readonly emailProvider: EmailProvider
  /** The Nous address (`SUPPORT_EMAIL`): named in the emails, and the Nous copy's recipient. */
  readonly supportEmail: string
}

export type SecuritySummary = {
  claimed: number
  contained: number
  notified: number
  failed: number
}

export type SecurityPhaseResult = {
  readonly summary: SecuritySummary
  /** false: the phase could not talk to the database as the contract says (claim or record). */
  readonly ok: boolean
  /** The first error code of the phase, or null. */
  readonly error: string | null
}

// ---------------------------------------------------------------------------------------------
// The answers of the RPCs (contract 1.9 §2.6)
// ---------------------------------------------------------------------------------------------

const ClaimResult = z.object({ items: z.array(z.unknown()), more: z.boolean() })

export const ClaimedSecurityEvent = z.object({
  id: Id,
  lease_id: Id,
  kind: SecurityEventKind,
  user_id: Id,
  factor_id: Id,
  attempts: z.int().check(z.gte(1)),
})
export type ClaimedSecurityEvent = z.infer<typeof ClaimedSecurityEvent>

/** Enough of an item to release its lease when the rest is unusable. */
const ClaimedLease = z.object({ id: Id, lease_id: Id })

/** One email of the bundle `queue_security_notifications` returns. */
export const SecurityEmailItem = z.object({
  audience: SecurityEmailAudience,
  to: z.string(),
  locale: Locale,
  timezone: z.string(),
  business_name: z.nullable(z.string()),
  account_email: z.string(),
})
export type SecurityEmailItem = z.infer<typeof SecurityEmailItem>

/** One business of the bundle (0012), for the Nous copy: `<name> (<slug>)`. */
const NotifyBusiness = z.object({ name: z.string(), slug: z.string() })

const Notify = z.object({
  kind: SecurityEventKind,
  detected_at: Instant,
  push_queued: z.int().check(z.gte(0)),
  /** Parsed one by one: a malformed entry fails alone. */
  emails: z.array(z.unknown()),
  /**
   * 0012 (contract 1.9b §2.4.5): the account's address (null: it has none) and its owner/manager
   * businesses in the event's order, for the Nous copy. Optional, and each business parsed alone
   * (an invalid one is skipped): a database without 0012 still gets its Nous copy.
   */
  account_email: z.optional(z.nullable(z.string())),
  businesses: z.optional(z.array(z.unknown())),
})
type Notify = z.infer<typeof Notify>

const ContainedAnswer = z.union([
  z.object({ recorded: z.literal(true), notify: Notify }),
  z.object({ recorded: z.literal(false) }),
])
const RecordedAnswer = z.object({ recorded: z.boolean() })

type Outcome = 'contained' | 'contain_failed' | 'notified'

function recordArgs(
  event: { id: string; lease_id: string },
  outcome: Outcome,
  extra: { emailsSent?: number; emailsFailed?: number; error?: string } = {},
) {
  return {
    p_id: event.id,
    p_lease_id: event.lease_id,
    p_outcome: outcome,
    p_emails_sent: extra.emailsSent ?? null,
    p_emails_failed: extra.emailsFailed ?? null,
    p_error: extra.error ?? null,
  }
}

type RpcCall = { ok: true; data: unknown } | { ok: false; code: string }

/** One RPC; a thrown error (network) becomes a code, never an exception. */
async function call(
  rpc: Rpc,
  fn: string,
  args: Readonly<Record<string, unknown>>,
): Promise<RpcCall> {
  try {
    const { data, error } = await rpc(fn, args)
    if (error !== null) return { ok: false, code: error.code ?? `${fn}_failed` }
    return { ok: true, data }
  } catch {
    return { ok: false, code: `${fn}_exception` }
  }
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

/** Deletes an added factor (404 = already gone) and revokes every session; the first error code. */
async function contain(services: SecurityServices, event: ClaimedSecurityEvent) {
  let failure: string | null = null
  if (event.kind === 'factor_added_unauthorized') {
    try {
      const deleted = await services.factors.deleteFactor(event.user_id, event.factor_id)
      if (!deleted.ok && deleted.status !== 404) failure = 'factor_delete_failed'
    } catch {
      failure = 'factor_delete_failed'
    }
  }
  // Attempted even when the delete failed: the sessions go as soon as possible.
  const revoked = await call(services.rpc, 'revoke_user_sessions', { p_user_id: event.user_id })
  if (!revoked.ok) failure ??= 'revoke_failed'
  return failure
}

type EmailOutcome = 'sent' | 'failed'

/**
 * Renders and sends one email; every failure (render, sender answer, throw) is logged and
 * counted, never retried. `fields` name the email in the log: never its address or its text.
 */
async function deliver(
  services: SecurityServices,
  log: Log,
  fields: Readonly<Record<string, LogValue>>,
  email: { to: string; idempotencyKey: string; render: () => { subject: string; text: string } },
): Promise<EmailOutcome> {
  let subject: string
  let text: string
  try {
    const rendered = email.render()
    subject = rendered.subject
    text = rendered.text
  } catch {
    log('security_email', { ...fields, outcome: 'failed', error: 'render_error' })
    return 'failed'
  }

  try {
    const result = await services.emailProvider.send({
      to: email.to,
      subject,
      text,
      idempotencyKey: email.idempotencyKey,
    })
    if (result.ok) {
      log('security_email', { ...fields, outcome: 'sent', error: null })
      return 'sent'
    }
    log('security_email', { ...fields, outcome: result.outcome, error: result.error })
  } catch {
    log('security_email', { ...fields, outcome: 'unknown', error: 'provider_exception' })
  }
  return 'failed'
}

/** One email of the bundle (`index` = its position): to the account or to an owner. */
function sendOne(
  services: SecurityServices,
  log: Log,
  event: ClaimedSecurityEvent,
  detectedAt: Date,
  raw: unknown,
  index: number,
): Promise<EmailOutcome> {
  const parsed = SecurityEmailItem.safeParse(raw)
  if (!parsed.success) {
    log('security_email', { id: event.id, index, outcome: 'failed', error: 'invalid_email_item' })
    return Promise.resolve('failed')
  }
  const email = parsed.data
  return deliver(
    services,
    log,
    { id: event.id, index, audience: email.audience },
    {
      to: email.to,
      idempotencyKey: `security:${event.id}:${index}`,
      render: () =>
        renderSecurityEmail(securityEmailKey(event.kind, email.audience), email.locale, {
          account: email.account_email,
          date: formatInZone(detectedAt, email.timezone, SECURITY_EMAIL_DATE_PATTERN, email.locale),
          time: formatInZone(detectedAt, email.timezone, SECURITY_EMAIL_TIME_PATTERN, email.locale),
          support: services.supportEmail,
          ...(email.business_name === null ? {} : { business: email.business_name }),
        }),
    },
  )
}

/**
 * The values of the Nous copy (contract 1.9b §3.2): the account (its address, else the user id),
 * its businesses as `<name> (<slug>)` in the bundle's order (`-` when none), the detection in UTC,
 * the event id and the number of owner emails in the bundle.
 */
function nousEmailValues(
  event: Pick<ClaimedSecurityEvent, 'id' | 'user_id'>,
  detectedAt: Date,
  notify: Pick<Notify, 'account_email' | 'businesses' | 'emails'>,
): SecurityEmailValues {
  const businesses = (notify.businesses ?? []).flatMap((raw) => {
    const parsed = NotifyBusiness.safeParse(raw)
    return parsed.success ? [`${parsed.data.name} (${parsed.data.slug})`] : []
  })
  const owners = notify.emails.filter((raw) => {
    const parsed = SecurityEmailItem.safeParse(raw)
    return parsed.success && parsed.data.audience === 'owner'
  }).length
  const accountEmail = notify.account_email?.trim() ?? ''
  return {
    account: accountEmail === '' ? event.user_id : accountEmail,
    businesses: businesses.length > 0 ? businesses.join(', ') : '-',
    date: formatInZone(
      detectedAt,
      SECURITY_NOUS_TIME_ZONE,
      SECURITY_EMAIL_DATE_PATTERN,
      SECURITY_NOUS_LOCALE,
    ),
    time: formatInZone(
      detectedAt,
      SECURITY_NOUS_TIME_ZONE,
      SECURITY_EMAIL_TIME_PATTERN,
      SECURITY_NOUS_LOCALE,
    ),
    event: event.id,
    owners: String(owners),
  }
}

/** The Nous copy of a contained event: once, to `SUPPORT_EMAIL` (contract 1.9b B1–B3). */
function sendNous(
  services: SecurityServices,
  log: Log,
  event: ClaimedSecurityEvent,
  detectedAt: Date,
  notify: Notify,
): Promise<EmailOutcome> {
  return deliver(
    services,
    log,
    { id: event.id, index: null, audience: 'nous' },
    {
      to: services.supportEmail,
      idempotencyKey: `security:${event.id}:nous`,
      render: () =>
        renderSecurityEmail(
          securityEmailKey(event.kind, 'nous'),
          SECURITY_NOUS_LOCALE,
          nousEmailValues(event, detectedAt, notify),
        ),
    },
  )
}

type EventResult =
  /** Contained and notified (or the notified record was refused: logged only). */
  | { kind: 'notified' }
  /** Containment failed: recorded `contain_failed`, nothing sent; the next run retries it. */
  | { kind: 'contain_failed' }
  /** Another dispatcher holds the event (a refused `contained`): nothing sent. */
  | { kind: 'lease_lost' }
  /** The database misbehaved (error or an answer off the contract): the phase stops. */
  | { kind: 'stop'; error: string }

async function handleEvent(
  services: SecurityServices,
  log: Log,
  event: ClaimedSecurityEvent,
  summary: SecuritySummary,
): Promise<EventResult> {
  const { rpc } = services
  const base = { id: event.id, kind: event.kind, attempts: event.attempts }

  // 1. Contain.
  const failure = await contain(services, event)
  if (failure !== null) {
    summary.failed += 1
    const recorded = await call(
      rpc,
      'record_security_event_result',
      recordArgs(event, 'contain_failed', { error: failure }),
    )
    log('security_event', { ...base, step: 'contain', outcome: 'contain_failed', error: failure })
    if (!recorded.ok) {
      log('security_record_failed', {
        id: event.id,
        step: 'contain_failed',
        sqlstate: recorded.code,
      })
      return { kind: 'stop', error: recorded.code }
    }
    return { kind: 'contain_failed' }
  }

  // 2. Contained: the owners' push is queued and the email bundle comes back.
  const contained = await call(rpc, 'record_security_event_result', recordArgs(event, 'contained'))
  if (!contained.ok) {
    log('security_record_failed', { id: event.id, step: 'contained', sqlstate: contained.code })
    return { kind: 'stop', error: contained.code }
  }
  const answer = ContainedAnswer.safeParse(contained.data)
  if (!answer.success) {
    // Contained but unreadable: nothing is sent; the next claim closes it notify_unknown.
    log('security_record_failed', { id: event.id, step: 'contained', sqlstate: null })
    return { kind: 'stop', error: 'invalid_notify' }
  }
  if (!answer.data.recorded) {
    log('security_lease_lost', { id: event.id, step: 'contained' })
    return { kind: 'lease_lost' }
  }
  summary.contained += 1
  const notify = answer.data.notify

  // 3. Notify: every email of the bundle and the Nous copy, each once, in parallel.
  const detectedAt = new Date(notify.detected_at)
  const outcomes = await Promise.all([
    ...notify.emails.map((raw, index) => sendOne(services, log, event, detectedAt, raw, index)),
    sendNous(services, log, event, detectedAt, notify),
  ])
  const sent = Math.min(MAX_EMAIL_COUNT, outcomes.filter((o) => o === 'sent').length)
  const failed = Math.min(
    MAX_EMAIL_COUNT,
    outcomes.length - outcomes.filter((o) => o === 'sent').length,
  )

  // 4. Notified.
  const notified = await call(
    rpc,
    'record_security_event_result',
    recordArgs(event, 'notified', { emailsSent: sent, emailsFailed: failed }),
  )
  const counts = { emails_sent: sent, emails_failed: failed, push_queued: notify.push_queued }
  if (!notified.ok) {
    log('security_record_failed', { id: event.id, step: 'notified', sqlstate: notified.code })
    log('security_event', { ...base, step: 'notify', outcome: 'not_recorded', ...counts })
    return { kind: 'stop', error: notified.code }
  }
  const recorded = RecordedAnswer.safeParse(notified.data)
  if (recorded.success && recorded.data.recorded) {
    summary.notified += 1
  } else {
    // The lease ran out while sending: the next claim closed it notify_unknown. Never re-sent.
    log('security_lease_lost', { id: event.id, step: 'notified' })
  }
  log('security_event', { ...base, step: 'notify', outcome: 'notified', ...counts })
  return { kind: 'notified' }
}

/**
 * Claims and handles up to `SECURITY_MAX_EVENTS` security events, one at a time, with no new
 * claim after `SECURITY_TIME_BUDGET_MS`. A claim error or an answer off the contract ends the
 * phase with `ok = false`. After a `contain_failed` the phase ends too: the failed event is the
 * oldest pending one, so the next claim would only return it again; the next run retries it.
 */
export async function handleSecurityEvents(
  services: SecurityServices,
  log: Log,
  now: () => number,
): Promise<SecurityPhaseResult> {
  const started = now()
  const summary: SecuritySummary = { claimed: 0, contained: 0, notified: 0, failed: 0 }
  let ok = true
  let error: string | null = null
  const stop = (code: string) => {
    ok = false
    error ??= code
  }

  phase: while (
    summary.claimed < SECURITY_MAX_EVENTS &&
    now() - started < SECURITY_TIME_BUDGET_MS
  ) {
    const claim = await call(services.rpc, 'claim_security_events', { p_limit: 1 })
    if (!claim.ok) {
      log('security_claim_failed', { sqlstate: claim.code })
      stop(claim.code)
      break
    }
    const parsed = ClaimResult.safeParse(claim.data)
    if (!parsed.success) {
      log('security_claim_failed', { sqlstate: null, reason: 'invalid_result' })
      stop('invalid_claim')
      break
    }
    if (parsed.data.items.length === 0) break

    for (const raw of parsed.data.items) {
      summary.claimed += 1
      const item = ClaimedSecurityEvent.safeParse(raw)
      if (!item.success) {
        // Off the contract: release it as contain_failed (the next run sees it again).
        summary.failed += 1
        const lease = ClaimedLease.safeParse(raw)
        if (lease.success) {
          await call(
            services.rpc,
            'record_security_event_result',
            recordArgs(lease.data, 'contain_failed', { error: 'invalid_claim' }),
          )
        }
        log('security_invalid_claim', { id: lease.success ? lease.data.id : null })
        stop('invalid_claim')
        break phase
      }
      const result = await handleEvent(services, log, item.data, summary)
      if (result.kind === 'stop') {
        stop(result.error)
        break phase
      }
      if (result.kind === 'contain_failed') break phase
    }
  }
  return { summary, ok, error }
}
