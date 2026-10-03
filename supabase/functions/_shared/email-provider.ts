import { z } from 'zod/mini'
import type { AnakloEnv } from './booking-config.ts'
import type { SendResult } from './push-provider.ts'

/**
 * The email sender behind the security emails of `dispatch` (contract 1.9 §3.3), like
 * `sms-provider.ts` and `push-provider.ts`. Pure (ADR-0002 §3): settings and `fetch` come in as
 * arguments from `index.ts`.
 *
 * Only the fake sender runs in 1.9 (`EMAIL_PROVIDER=fake`, `email-config.ts`): it records the
 * request and sends nothing. The Resend sender below is written and tested with a fake `fetch`
 * only; 1.10 adds `resend` to `EMAIL_PROVIDER_NAMES` with `RESEND_API_KEY` and `EMAIL_FROM`.
 *
 * Plain text only, never a link (contract 1.9 D14). A sender never logs a body or a full address.
 */

export type EmailSendRequest = {
  readonly to: string
  readonly subject: string
  /** Plain text. */
  readonly text: string
  /** `security:<event id>:<index>`: Resend's `Idempotency-Key` from 1.10. */
  readonly idempotencyKey: string
}

/** `SendResult` of push-provider.ts: `failed` / `rejected` / `unknown` carry a short code. */
export interface EmailProvider {
  readonly name: string
  send(request: EmailSendRequest): Promise<SendResult>
}

export type EmailProviderLog = (line: string) => void

/** `fake` only in 1.9; `resend` joins in 1.10 (contract 1.9 §3.3, §6). */
export type EmailProviderName = 'fake'

const EmailAddress = z.email()

/** `nikos@demo-barber.test` → `n***@demo-barber.test`: tells test accounts apart, nothing more. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 1 || at === address.length - 1) return '***'
  return `${Array.from(address)[0] ?? ''}***${address.slice(at)}`
}

export type CreateFakeEmailProviderOptions = {
  readonly env: AnakloEnv
  /** Defaults to `console.info`. Only with `ANAKLO_ENV=local`: a masked address, never the body. */
  readonly log?: EmailProviderLog
  /** Vitest: receives the exact request a real sender would have sent. */
  readonly record?: (request: EmailSendRequest) => void
  /** For tests; defaults to `crypto.randomUUID()`. */
  readonly randomId?: () => string
}

/**
 * Never sends. Refuses a recipient that is not an email address (as a real sender would), hands
 * the whole request to `record` and answers like a provider that accepted it. With
 * `ANAKLO_ENV=local` it logs one line: the masked recipient, the idempotency key and the subject
 * (the edge runtime log is where the local drill sees it).
 */
export function createFakeEmailProvider(options: CreateFakeEmailProviderOptions): EmailProvider {
  // Second line of defence: parseEmailConfig already refuses this combination.
  if (options.env === 'prod') throw new Error('The fake email sender is refused in prod.')
  const log = options.log ?? ((line: string) => console.info(line))
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  return {
    name: 'fake',
    send(request) {
      if (!EmailAddress.safeParse(request.to).success) {
        return Promise.resolve({ ok: false, outcome: 'failed', error: 'invalid_recipient' })
      }
      options.record?.(request)
      if (options.env === 'local') {
        log(
          `fake-email to=${maskEmail(request.to)} key=${request.idempotencyKey} subject=${request.subject}`,
        )
      }
      return Promise.resolve({ ok: true, providerMessageId: `fake-email-${randomId()}` })
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Resend (1.10): written now behind the interface, tested with a fake fetch, never selected by
// the configuration of 1.9.
// ---------------------------------------------------------------------------------------------

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails'

/** A Resend call ends well inside the 120 s lease of a security event (contract 1.9 §2.6). */
export const RESEND_TIMEOUT_MS = 8_000

export type CreateResendEmailProviderOptions = {
  readonly apiKey: string
  /** `Anaklo <security@mail.anaklo.gr>` (1.10, `EMAIL_FROM`). */
  readonly from: string
  readonly fetch: typeof fetch
  readonly timeoutMs?: number
}

const ResendCreated = z.object({ id: z.optional(z.nullable(z.string())) })

/**
 * The Resend REST sender. Never logs: the key, the addresses and the texts stay inside.
 * - 2xx with an id → sent; 2xx without a readable id → `unknown` (it may have been accepted);
 * - 429 and 5xx → `failed` (not accepted), any other status → `rejected`;
 * - network error or timeout → `unknown`.
 * The caller never retries a security email (contract 1.9 D16), whatever the outcome.
 */
export function createResendEmailProvider(
  options: CreateResendEmailProviderOptions,
): EmailProvider {
  const timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS
  return {
    name: 'resend',
    async send(request) {
      if (!EmailAddress.safeParse(request.to).success) {
        return { ok: false, outcome: 'failed', error: 'invalid_recipient' }
      }
      let response: Response
      try {
        response = await options.fetch(RESEND_EMAILS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Idempotency-Key': request.idempotencyKey,
          },
          body: JSON.stringify({
            from: options.from,
            to: [request.to],
            subject: request.subject,
            text: request.text,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        const timedOut =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        return { ok: false, outcome: 'unknown', error: timedOut ? 'timeout' : 'network' }
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        const status = response.status
        const outcome = status === 429 || status >= 500 ? 'failed' : 'rejected'
        return { ok: false, outcome, error: `http_${status}` }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { ok: false, outcome: 'unknown', error: 'invalid_response' }
      }
      const created = ResendCreated.safeParse(body)
      const id = created.success ? (created.data.id ?? '').trim() : ''
      if (id === '') return { ok: false, outcome: 'unknown', error: 'invalid_response' }
      return { ok: true, providerMessageId: id }
    },
  }
}

export type CreateEmailProviderOptions = {
  readonly env: AnakloEnv
  readonly provider: EmailProviderName
  readonly log?: EmailProviderLog
  readonly record?: (request: EmailSendRequest) => void
}

/** The sender `EMAIL_PROVIDER` names: `fake` only in 1.9. Throws for `fake` in prod. */
export function createEmailProvider(options: CreateEmailProviderOptions): EmailProvider {
  switch (options.provider) {
    case 'fake':
      return createFakeEmailProvider({
        env: options.env,
        ...(options.log === undefined ? {} : { log: options.log }),
        ...(options.record === undefined ? {} : { record: options.record }),
      })
  }
}
