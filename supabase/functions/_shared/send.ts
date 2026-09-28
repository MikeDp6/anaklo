import { z } from 'zod/mini'
import type { BookingConfig } from './booking-config.ts'
import { Id, Instant, isShortCode, ManageToken, PhoneE164 } from './booking-schemas.ts'
import type { Log, Rpc } from './booking-rpc.ts'
import { formatInZone } from './dates.ts'
import { Locale } from './domain.ts'
import type { SmsVariable } from './sms.ts'
import { renderSms, SMS_TEMPLATES, type SmsTemplateKey } from './sms-templates.ts'
import type { SmsProvider, SmsSendResult } from './sms-provider.ts'

/**
 * Sends SMS rows of `messages_log` right after the RPC that queued them has committed
 * (contract 1.3 §6, SPEC §12): claim → render in the client's language → adapter → record.
 * Pure (ADR-0002 §3): the database (`rpc`) and the adapter come in from `index.ts`; the
 * dispatcher of 1.5a reuses it.
 *
 * Only `queued` rows are ever claimed, so a retry never sends twice; a row stuck in `sending`
 * is left to the 1.5a sweep. Logs carry ids, templates and outcome codes only.
 */

export type SendOutcome = 'sent' | 'rejected' | 'failed' | 'not_claimed'

export type SendConfig = Pick<BookingConfig, 'siteHost' | 'smsDomain' | 'allowedRecipients'>

export type SendVariables = Partial<Record<SmsVariable, string>>

export type SendMessagesOptions = {
  readonly rpc: Rpc
  readonly provider: SmsProvider
  readonly config: SendConfig
  readonly ids: readonly string[]
  /** Per message id, values that exist only in memory (the OTP `code`). */
  readonly extraVars?: Readonly<Record<string, SendVariables>>
  readonly log: Log
}

/** `Τετ 30/09`, `Wed 30/09`: 9 septets at most (ADR-0007), tested for every weekday. */
export const SMS_DATE_PATTERN = 'EEE dd/MM'
export const SMS_TIME_PATTERN = 'HH:mm'

/** Templates whose link is the manage link `/m/<token>` (a new token per message, §2.6.9). */
export const MANAGE_LINK_TEMPLATES: ReadonlySet<SmsTemplateKey> = new Set([
  'booking_confirmed',
  'reminder',
  'rescheduled_by_client',
])
/** Templates whose link is the short booking link `/r/<code>`. */
export const SHORT_LINK_TEMPLATES: ReadonlySet<SmsTemplateKey> = new Set([
  'cancelled_by_client',
  'cancelled_by_business',
])

const SMS_TEMPLATE_KEYS = Object.keys(SMS_TEMPLATES) as SmsTemplateKey[]

/** One row of `claim_messages` (§2.6.9). */
export const ClaimedMessage = z.object({
  id: Id,
  lease_id: Id,
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
export type ClaimedMessage = z.infer<typeof ClaimedMessage>

/** Enough of a row to release its lease when the rest of it is unusable. */
const ClaimedLease = z.object({ id: Id, lease_id: Id })

export function manageLink(siteHost: string, token: string): string {
  return `${siteHost}/m/${token}`
}

export function shortLink(siteHost: string, code: string): string {
  return `${siteHost}/r/${code}`
}

/**
 * The variables of one claimed row. Throws (→ `render_error`) when the row lacks what its
 * template needs; `renderSms` throws for a missing or over-long exact value.
 */
export function messageVariables(
  row: ClaimedMessage,
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

type Recorded =
  | { outcome: 'sent'; provider: string; result: Extract<SmsSendResult, { ok: true }> }
  | { outcome: 'failed'; provider: string | null; error: string }
  | { outcome: 'rejected'; error: string }

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
  switch (recorded.outcome) {
    case 'sent': {
      const { providerMessageId, segments, costCents } = recorded.result
      return {
        ...base,
        p_provider: recorded.provider.slice(0, 40),
        p_provider_message_id: providerMessageId.slice(0, 120),
        p_segments: Math.min(10, Math.max(1, Math.trunc(segments) || 1)),
        p_cost_cents:
          costCents === null || !Number.isFinite(costCents)
            ? null
            : Math.max(0, Math.round(costCents)),
      }
    }
    case 'failed':
      return {
        ...base,
        p_provider: recorded.provider?.slice(0, 40) ?? null,
        p_error: errorCode(recorded.error),
      }
    case 'rejected':
      return { ...base, p_error: errorCode(recorded.error) }
  }
}

/** A provider error is recorded only when it looks like a code: free text may hold a number. */
const ERROR_CODE = /^[A-Za-z][\w.:-]{0,79}$/

function errorCode(error: string): string {
  return ERROR_CODE.test(error) ? error : 'provider_error'
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
    if (error !== null || data !== true) {
      log('sms_record_failed', { id: lease.id, sqlstate: error?.code ?? null })
    }
  } catch {
    log('sms_record_failed', { id: lease.id, sqlstate: null })
  }
}

async function claim(rpc: Rpc, log: Log, ids: readonly string[]): Promise<unknown[]> {
  try {
    const { data, error } = await rpc('claim_messages', { p_ids: ids })
    if (error !== null) {
      log('sms_claim_failed', { ids, sqlstate: error.code ?? null })
      return []
    }
    return Array.isArray(data) ? (data as unknown[]) : []
  } catch {
    log('sms_claim_failed', { ids, sqlstate: null })
    return []
  }
}

async function sendOne(
  options: SendMessagesOptions,
  row: ClaimedMessage,
): Promise<Exclude<SendOutcome, 'not_claimed'>> {
  const { rpc, provider, config, log } = options
  const allowed = config.allowedRecipients
  if (allowed.size > 0 && !allowed.has(row.to_e164)) {
    await record(rpc, log, row, { outcome: 'rejected', error: 'recipient_not_allowed' })
    return 'rejected'
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
    await record(rpc, log, row, { outcome: 'failed', provider: null, error: 'render_error' })
    return 'failed'
  }

  let result: SmsSendResult
  try {
    result = await provider.send({ to: row.to_e164, text, segments })
  } catch {
    result = { ok: false, error: 'provider_exception' }
  }
  if (result.ok) {
    await record(rpc, log, row, { outcome: 'sent', provider: provider.name, result })
    return 'sent'
  }
  await record(rpc, log, row, { outcome: 'failed', provider: provider.name, error: result.error })
  return 'failed'
}

/**
 * Claims and sends the given `messages_log` ids. Returns an outcome for every requested id:
 * `not_claimed` when the row was not claimable (not queued, not due, SMS switched off, daily
 * cap reached, already taken) or the claim failed.
 */
export async function sendMessages(
  options: SendMessagesOptions,
): Promise<Record<string, SendOutcome>> {
  const outcomes: Record<string, SendOutcome> = {}
  for (const id of options.ids) outcomes[id] = 'not_claimed'
  if (options.ids.length === 0) return outcomes

  const { rpc, log } = options
  for (const raw of await claim(rpc, log, options.ids)) {
    const parsed = ClaimedMessage.safeParse(raw)
    if (!parsed.success) {
      const lease = ClaimedLease.safeParse(raw)
      if (lease.success) {
        await record(rpc, log, lease.data, {
          outcome: 'failed',
          provider: null,
          error: 'invalid_claim',
        })
        if (Object.hasOwn(outcomes, lease.data.id)) outcomes[lease.data.id] = 'failed'
      }
      log('sms_invalid_claim', { id: lease.success ? lease.data.id : null })
      continue
    }
    const row = parsed.data
    const outcome = await sendOne(options, row)
    if (Object.hasOwn(outcomes, row.id)) outcomes[row.id] = outcome
    log('sms_send', { id: row.id, template: row.template, outcome })
  }
  return outcomes
}
