import { z } from 'zod/mini'
import type { BookingConfig } from './booking-config.ts'
import { Id, Instant, isShortCode, ManageToken, PhoneE164 } from './booking-schemas.ts'
import type { Log, Rpc } from './booking-rpc.ts'
import { formatInZone, toLocalDate } from './dates.ts'
import { Locale } from './domain.ts'
import { appUrl, OneSignalSubscriptionId } from './onesignal.ts'
import type { PushProvider, SendResult } from './push-provider.ts'
import {
  capPushValue,
  PUSH_CLIENT_FALLBACK,
  PUSH_TEMPLATE_KEYS,
  PUSH_VARIABLE_LIMITS,
  renderPushAllLocales,
  type PushLocale,
  type PushTemplate,
} from './push-templates.ts'
import type { SmsVariable } from './sms.ts'
import { renderSms, SMS_TEMPLATES, type SmsTemplateKey } from './sms-templates.ts'
import type { SmsProvider } from './sms-provider.ts'

/**
 * Sends leased rows of `messages_log` (contract 1.3 §6, 1.5 §3.2, SPEC §12): claim → render in
 * the recipient's language → sender → record. Pure (ADR-0002 §3): the database (`rpc`) and the
 * senders come in from `index.ts`. Two entry points share everything else:
 * - `sendMessages`: the ids an RPC just queued (`claim_messages`), right after it committed
 *   (`public-booking`, `manage`);
 * - `sendClaimed`: the items `claim_due_messages` returned (`dispatch`).
 *
 * Only `queued` rows are ever claimed and a row in `sending` is never claimed again, so no retry
 * or concurrent sender sends a message twice; a row whose sender died is closed as `unknown` by
 * the sweep (contract 1.5 D23). Logs carry ids, channels, templates and outcome codes only:
 * never phones, codes, tokens, subscription ids, names or texts.
 */

export type SendOutcome = 'sent' | 'rejected' | 'failed' | 'unknown' | 'not_claimed'
export type SentOutcome = Exclude<SendOutcome, 'not_claimed'>

export type SendConfig = Pick<BookingConfig, 'siteHost' | 'smsDomain' | 'allowedRecipients'>

export type SendVariables = Partial<Record<SmsVariable, string>>

export type SendServices = {
  readonly rpc: Rpc
  /** The SMS adapter (`sms-provider.ts`). */
  readonly provider: SmsProvider
  /** The push sender (`push-provider.ts`). */
  readonly pushProvider: PushProvider
  readonly config: SendConfig
  /** Per message id, values that exist only in memory (the OTP `code`). */
  readonly extraVars?: Readonly<Record<string, SendVariables>>
  readonly log: Log
}

export type SendMessagesOptions = SendServices & { readonly ids: readonly string[] }

/** `Τετ 30/09`, `Wed 30/09`: 9 septets at most (ADR-0007), tested for every weekday. */
export const SMS_DATE_PATTERN = 'EEE dd/MM'
export const SMS_TIME_PATTERN = 'HH:mm'
/** Push shows the same short date and time as SMS (contract 1.5 §3.2), in normal case. */
export const PUSH_DATE_PATTERN = SMS_DATE_PATTERN
export const PUSH_TIME_PATTERN = SMS_TIME_PATTERN

/** Templates whose link is the manage link `/m/<token>` (a new token per message, §2.6.9). */
export const MANAGE_LINK_TEMPLATES: ReadonlySet<SmsTemplateKey> = new Set([
  'booking_confirmed',
  'reminder',
  'rescheduled_by_client',
  'rescheduled_by_business',
])
/** Templates whose link is the short booking link `/r/<code>`. */
export const SHORT_LINK_TEMPLATES: ReadonlySet<SmsTemplateKey> = new Set([
  'cancelled_by_client',
  'cancelled_by_business',
])

const SMS_TEMPLATE_KEYS = Object.keys(SMS_TEMPLATES) as SmsTemplateKey[]

// ---------------------------------------------------------------------------------------------
// One item of `claim_messages` / `claim_due_messages` (contract 1.5 §2.8). Every key is always
// present, null where it does not apply; only what the channel needs is kept after parsing.
// ---------------------------------------------------------------------------------------------

export const ClaimedSms = z.object({
  id: Id,
  lease_id: Id,
  channel: z.literal('sms'),
  to_e164: PhoneE164,
  locale: Locale,
  template: z.enum(SMS_TEMPLATE_KEYS),
  business_name: z.string(),
  short_code: z.string(),
  timezone: z.string(),
  starts_at: z.nullable(Instant),
  staff_name: z.nullable(z.string()),
  manage_token: z.nullable(ManageToken),
})
export type ClaimedSms = z.infer<typeof ClaimedSms>

/**
 * A device of the recipient, from `push_subscriptions` at claim time. VAPID rows are accepted
 * and skipped in 1.5 (contract D18): nothing of them is kept.
 */
const PushTarget = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('onesignal'), subscription_id: OneSignalSubscriptionId }),
  z.object({ provider: z.literal('vapid') }),
])

export const ClaimedPush = z.object({
  id: Id,
  lease_id: Id,
  channel: z.literal('push'),
  locale: Locale,
  template: z.enum(PUSH_TEMPLATE_KEYS),
  timezone: z.nullable(z.string()),
  starts_at: z.nullable(Instant),
  staff_name: z.nullable(z.string()),
  /** First word of the client's name (null: none or erased). Never the surname or the phone. */
  client_first_name: z.nullable(z.string()),
  service_name: z.nullable(z.string()),
  push_targets: z.array(PushTarget),
})
export type ClaimedPush = z.infer<typeof ClaimedPush>

export const ClaimedMessage = z.discriminatedUnion('channel', [ClaimedSms, ClaimedPush])
export type ClaimedMessage = z.infer<typeof ClaimedMessage>

/** Enough of an item to release its lease when the rest of it is unusable. */
const ClaimedLease = z.object({ id: Id, lease_id: Id })

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export function manageLink(siteHost: string, token: string): string {
  return `${siteHost}/m/${token}`
}

export function shortLink(siteHost: string, code: string): string {
  return `${siteHost}/r/${code}`
}

/**
 * The variables of one claimed SMS. Throws (→ `render_error`) when the row lacks what its
 * template needs; `renderSms` throws for a missing or over-long exact value.
 */
export function messageVariables(
  row: ClaimedSms,
  config: Pick<SendConfig, 'siteHost' | 'smsDomain'>,
  extra: SendVariables = {},
): SendVariables {
  const vars: SendVariables = { ...extra, business: row.business_name, domain: config.smsDomain }
  if (row.starts_at !== null) {
    const instant = new Date(row.starts_at)
    vars.date = formatInZone(instant, row.timezone, SMS_DATE_PATTERN, row.locale)
    vars.time = formatInZone(instant, row.timezone, SMS_TIME_PATTERN, row.locale)
  }
  if (row.staff_name !== null) vars.staff = row.staff_name
  if (MANAGE_LINK_TEMPLATES.has(row.template)) {
    if (row.manage_token === null) throw new Error(`${row.template} needs a manage token`)
    vars.link = manageLink(config.siteHost, row.manage_token)
  } else if (SHORT_LINK_TEMPLATES.has(row.template)) {
    if (!isShortCode(row.short_code)) throw new Error(`${row.template} needs a short code`)
    vars.link = shortLink(config.siteHost, row.short_code)
  }
  return vars
}

/** The first word only: a surname never reaches a lock screen, even if the row carried one. */
function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/u)[0] ?? ''
  return first === '' ? null : first
}

/**
 * The variables of one push in one language (contract 1.5 §3.2), each within its limit. Throws
 * (→ `render_error`) for an appointment instant without a valid time zone; `renderPush` throws
 * when a template needs a value the item lacks.
 */
export function pushVariables(item: ClaimedPush, locale: PushLocale): Record<string, string> {
  const vars: Record<string, string> = {
    client: capPushValue(
      firstName(item.client_first_name) ?? PUSH_CLIENT_FALLBACK[locale],
      PUSH_VARIABLE_LIMITS.client,
    ),
  }
  if (item.service_name !== null && item.service_name.trim() !== '') {
    vars.service = capPushValue(item.service_name, PUSH_VARIABLE_LIMITS.service)
  }
  if (item.staff_name !== null && item.staff_name.trim() !== '') {
    vars.staff = capPushValue(item.staff_name, PUSH_VARIABLE_LIMITS.staff)
  }
  if (item.starts_at !== null) {
    if (item.timezone === null) throw new Error('A push about an appointment needs its time zone')
    const instant = new Date(item.starts_at)
    vars.date = formatInZone(instant, item.timezone, PUSH_DATE_PATTERN, locale)
    vars.time = formatInZone(instant, item.timezone, PUSH_TIME_PATTERN, locale)
  }
  return vars
}

/**
 * Where the tap opens: the pro app's day of the appointment (business-local date), or `/app/`
 * for the test push.
 */
export function pushUrl(siteHost: string, item: ClaimedPush): string {
  const base = appUrl(siteHost)
  if (item.template === 'push_test' || item.starts_at === null || item.timezone === null) {
    return base
  }
  return `${base}day?date=${toLocalDate(new Date(item.starts_at), item.timezone)}`
}

// ---------------------------------------------------------------------------------------------
// Recording (`record_send_result`, contract 1.5 §2.9)
// ---------------------------------------------------------------------------------------------

type Recorded =
  | {
      outcome: 'sent'
      provider: string
      providerMessageId: string
      segments: number | null
      costCents: number | null
    }
  | { outcome: 'failed' | 'unknown' | 'rejected'; provider: string | null; error: string }

/** A provider error is recorded only when it looks like a code: free text may hold a number. */
const ERROR_CODE = /^[A-Za-z][\w.:-]{0,79}$/

function errorCode(error: string): string {
  return ERROR_CODE.test(error) ? error : 'provider_error'
}

/** CHECKs of `messages_log`: segments 1–10, cost ≥ 0, text columns bounded. */
function recordArgs(id: string, leaseId: string, recorded: Recorded) {
  const base = {
    p_id: id,
    p_lease_id: leaseId,
    p_outcome: recorded.outcome,
    p_provider: null as string | null,
    p_provider_message_id: null as string | null,
    p_segments: null as number | null,
    p_cost_cents: null as number | null,
    p_error: null as string | null,
  }
  if (recorded.outcome === 'sent') {
    const { costCents, segments } = recorded
    return {
      ...base,
      p_provider: recorded.provider.slice(0, 40),
      p_provider_message_id: recorded.providerMessageId.slice(0, 120),
      p_segments: segments === null ? null : Math.min(10, Math.max(1, Math.trunc(segments) || 1)),
      p_cost_cents:
        costCents === null || !Number.isFinite(costCents)
          ? null
          : Math.max(0, Math.round(costCents)),
    }
  }
  return {
    ...base,
    p_provider: recorded.provider?.slice(0, 40) ?? null,
    p_error: errorCode(recorded.error),
  }
}

/** What a sender answered, as a row outcome. SMS segments default to the prepared count. */
function fromResult(provider: string, result: SendResult, segments: number | null): Recorded {
  if (result.ok) {
    return {
      outcome: 'sent',
      provider,
      providerMessageId: result.providerMessageId,
      segments: result.segments ?? segments,
      costCents: result.costCents ?? null,
    }
  }
  return { outcome: result.outcome, provider, error: result.error }
}

async function record(
  rpc: Rpc,
  log: Log,
  lease: { id: string; lease_id: string },
  recorded: Recorded,
): Promise<void> {
  try {
    const { data, error } = await rpc(
      'record_send_result',
      recordArgs(lease.id, lease.lease_id, recorded),
    )
    // false: the lease is no longer current (the sweep closed the row): nothing else to do.
    if (error !== null || data !== true) {
      log('message_record_failed', { id: lease.id, sqlstate: error?.code ?? null })
    }
  } catch {
    log('message_record_failed', { id: lease.id, sqlstate: null })
  }
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

type Sent = { outcome: SentOutcome; error: string | null }

async function settle(
  options: SendServices,
  lease: ClaimedMessage,
  recorded: Recorded,
): Promise<Sent> {
  await record(options.rpc, options.log, lease, recorded)
  return {
    outcome: recorded.outcome,
    error: recorded.outcome === 'sent' ? null : errorCode(recorded.error),
  }
}

async function sendSms(options: SendServices, row: ClaimedSms): Promise<Sent> {
  const { provider, config } = options
  const allowed = config.allowedRecipients
  if (allowed.size > 0 && !allowed.has(row.to_e164)) {
    return settle(options, row, {
      outcome: 'rejected',
      provider: null,
      error: 'recipient_not_allowed',
    })
  }

  let text: string
  let segments: number
  try {
    const sms = renderSms(
      row.template,
      row.locale,
      messageVariables(row, config, options.extraVars?.[row.id]),
    )
    text = sms.text
    segments = sms.segments
  } catch {
    return settle(options, row, { outcome: 'failed', provider: null, error: 'render_error' })
  }

  let result: SendResult
  try {
    result = await provider.send({ to: row.to_e164, text, segments })
  } catch {
    // It may have left: never retried (contract 1.5 D22).
    result = { ok: false, outcome: 'unknown', error: 'provider_exception' }
  }
  return settle(options, row, fromResult(provider.name, result, segments))
}

async function sendPush(options: SendServices, item: ClaimedPush): Promise<Sent> {
  const { pushProvider, config } = options
  // Only OneSignal devices in 1.5; VAPID rows wait for a VAPID sender (1.10 on no-go).
  const subscriptionIds = item.push_targets.flatMap((target) =>
    target.provider === 'onesignal' ? [target.subscription_id] : [],
  )
  if (subscriptionIds.length === 0) {
    return settle(options, item, {
      outcome: 'rejected',
      provider: null,
      error: 'provider_not_configured',
    })
  }

  let texts: Record<PushLocale, PushTemplate>
  let url: string
  try {
    texts = renderPushAllLocales(item.template, {
      el: pushVariables(item, 'el'),
      en: pushVariables(item, 'en'),
    })
    url = pushUrl(config.siteHost, item)
  } catch {
    return settle(options, item, { outcome: 'failed', provider: null, error: 'render_error' })
  }

  let result: SendResult
  try {
    result = await pushProvider.send({ subscriptionIds, texts, url })
  } catch {
    result = { ok: false, outcome: 'unknown', error: 'provider_exception' }
  }
  return settle(options, item, fromResult(pushProvider.name, result, null))
}

/**
 * Sends items a claim returned (leased by this caller). Returns the outcome of every item that
 * carried an id; an item that does not match the contract is released as `failed`
 * (`invalid_claim`) and sends nothing.
 */
export async function sendClaimed(
  options: SendServices,
  items: readonly unknown[],
): Promise<Record<string, SentOutcome>> {
  const outcomes: Record<string, SentOutcome> = {}
  const { rpc, log } = options
  for (const raw of items) {
    const parsed = ClaimedMessage.safeParse(raw)
    if (!parsed.success) {
      const lease = ClaimedLease.safeParse(raw)
      if (lease.success) {
        await record(rpc, log, lease.data, {
          outcome: 'failed',
          provider: null,
          error: 'invalid_claim',
        })
        outcomes[lease.data.id] = 'failed'
      }
      log('message_invalid_claim', { id: lease.success ? lease.data.id : null })
      continue
    }
    const item = parsed.data
    const sent =
      item.channel === 'sms' ? await sendSms(options, item) : await sendPush(options, item)
    outcomes[item.id] = sent.outcome
    log('message_send', {
      id: item.id,
      channel: item.channel,
      template: item.template,
      outcome: sent.outcome,
      error: sent.error,
    })
  }
  return outcomes
}

async function claim(rpc: Rpc, log: Log, ids: readonly string[]): Promise<unknown[]> {
  try {
    const { data, error } = await rpc('claim_messages', { p_ids: ids })
    if (error !== null) {
      log('message_claim_failed', { ids, sqlstate: error.code ?? null })
      return []
    }
    return Array.isArray(data) ? (data as unknown[]) : []
  } catch {
    log('message_claim_failed', { ids, sqlstate: null })
    return []
  }
}

/**
 * Claims and sends the given `messages_log` ids (SMS and push). Returns an outcome for every
 * requested id: `not_claimed` when the row was not claimable (not queued, not due, switched off,
 * a cap reached, already taken) or the claim failed.
 */
export async function sendMessages(
  options: SendMessagesOptions,
): Promise<Record<string, SendOutcome>> {
  const outcomes: Record<string, SendOutcome> = {}
  for (const id of options.ids) outcomes[id] = 'not_claimed'
  if (options.ids.length === 0) return outcomes

  const sent = await sendClaimed(options, await claim(options.rpc, options.log, options.ids))
  for (const [id, outcome] of Object.entries(sent)) {
    if (Object.hasOwn(outcomes, id)) outcomes[id] = outcome
  }
  return outcomes
}
