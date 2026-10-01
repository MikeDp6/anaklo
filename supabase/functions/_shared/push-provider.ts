import { z } from 'zod/mini'
import type { AnakloEnv } from './booking-config.ts'
import {
  buildPushPayload,
  ONESIGNAL_NOTIFICATIONS_URL,
  type OneSignalPushPayload,
} from './onesignal.ts'
import type { PushLocale, PushTemplate } from './push-templates.ts'

/**
 * The push sender behind `send.ts` (contract 1.5 §3.3), like `sms-provider.ts` for SMS. Pure
 * (ADR-0002 §3): settings and `fetch` come in as arguments from each `index.ts`.
 *
 * A push is addressed ONLY by OneSignal subscription ids (`include_subscription_ids`), which the
 * server takes from the `push_subscriptions` rows of the recipients it derived itself
 * (`claim_*`): never `external_id`, aliases or segments (ADR-0010 §2). Both senders build the
 * payload with `buildPushPayload`, so the fake one checks exactly what OneSignal would get.
 *
 * Until 1.10 only the fake sender runs (no key, no device); the OneSignal sender is tested with
 * a fake `fetch` and first used in 1.10.
 */

export type PushSendRequest = {
  /** OneSignal subscription ids (UUIDs) of the recipient's devices. */
  readonly subscriptionIds: readonly string[]
  readonly texts: Readonly<Record<PushLocale, PushTemplate>>
  /** Opened on tap; absolute. */
  readonly url: string | null
}

/**
 * What a sender (SMS or push) answers (contract 1.5 §3.3). The outcome decides the row's next
 * status (`record_send_result`, §2.9): `failed` = certainly not delivered to the provider (may
 * be retried), `rejected` = refused for good (row cancelled), `unknown` = maybe sent (never
 * retried). `error` is a short code, never personal data.
 */
export type SendResult =
  | {
      ok: true
      providerMessageId: string
      /** SMS: as the provider reports them (SPEC §12). Push: none. */
      segments?: number
      costCents?: number | null
    }
  | { ok: false; outcome: 'failed' | 'rejected' | 'unknown'; error: string }

export interface PushProvider {
  readonly name: string
  send(request: PushSendRequest): Promise<SendResult>
}

export type PushProviderLog = (line: string) => void

/** The app id of the fake sender's payloads: a valid UUID that no OneSignal app has. */
export const FAKE_PUSH_APP_ID = '00000000-0000-4000-8000-000000000000'

/** A OneSignal call ends well inside the 60 s lease of the claim (contract 1.5 §3.1). */
export const ONESIGNAL_TIMEOUT_MS = 8_000

export type CreateFakePushProviderOptions = {
  readonly env: AnakloEnv
  /** Defaults to `console.info`. Only with `ANAKLO_ENV=local`, and never ids or names. */
  readonly log?: PushProviderLog
  /** Vitest: receives the exact payload OneSignal would have received. */
  readonly record?: (payload: OneSignalPushPayload) => void
  /** For tests; defaults to `crypto.randomUUID()`. */
  readonly randomId?: () => string
}

/**
 * Never sends. Builds the exact OneSignal payload (so a subscription id that is not a UUID, or
 * an alias, fails here as it would there), hands it to `record` and answers like OneSignal
 * accepting it. With `ANAKLO_ENV=local` logs one line: how many devices and the Greek title.
 */
export function createFakePushProvider(options: CreateFakePushProviderOptions): PushProvider {
  // Second line of defence: parsePushConfig already refuses this combination.
  if (options.env === 'prod') throw new Error('The fake push sender is refused in prod.')
  const log = options.log ?? ((line: string) => console.info(line))
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  return {
    name: 'fake',
    send(request) {
      let payload: OneSignalPushPayload
      try {
        payload = buildPushPayload({ appId: FAKE_PUSH_APP_ID, ...request })
      } catch {
        return Promise.resolve({ ok: false, outcome: 'failed', error: 'invalid_payload' })
      }
      options.record?.(payload)
      if (options.env === 'local') {
        log(
          `fake-push subscriptions=${payload.include_subscription_ids.length} title=${payload.headings.el}`,
        )
      }
      return Promise.resolve({ ok: true, providerMessageId: `fake-push-${randomId()}` })
    },
  }
}

export type CreateOneSignalPushProviderOptions = {
  readonly appId: string
  readonly restApiKey: string
  readonly fetch: typeof fetch
  readonly timeoutMs?: number
}

/** OneSignal answers 200 with an empty (or no) `id` when no subscription is subscribed. */
const OneSignalCreated = z.object({ id: z.optional(z.nullable(z.string())) })

/** The OneSignal REST sender (1.10). Never logs: the key and the ids stay inside. */
export function createOneSignalPushProvider(
  options: CreateOneSignalPushProviderOptions,
): PushProvider {
  const timeoutMs = options.timeoutMs ?? ONESIGNAL_TIMEOUT_MS
  return {
    name: 'onesignal',
    async send(request) {
      let payload: OneSignalPushPayload
      try {
        payload = buildPushPayload({ appId: options.appId, ...request })
      } catch {
        return { ok: false, outcome: 'failed', error: 'invalid_payload' }
      }

      let response: Response
      try {
        response = await options.fetch(ONESIGNAL_NOTIFICATIONS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Key ${options.restApiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        // Maybe it arrived: never retried (contract 1.5 D22).
        const timedOut =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        return { ok: false, outcome: 'unknown', error: timedOut ? 'timeout' : 'network' }
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return { ok: false, outcome: 'failed', error: `http_${response.status}` }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        // 2xx whose body is lost: it was accepted or not, we cannot tell.
        return { ok: false, outcome: 'unknown', error: 'invalid_response' }
      }
      const created = OneSignalCreated.safeParse(body)
      const id = created.success ? (created.data.id ?? '').trim() : ''
      if (id === '') return { ok: false, outcome: 'rejected', error: 'not_subscribed' }
      return { ok: true, providerMessageId: id }
    },
  }
}

export type PushProviderName = 'fake' | 'onesignal'

export type CreatePushProviderOptions = {
  readonly env: AnakloEnv
  readonly provider: PushProviderName
  /** Required for `onesignal` (push-config.ts checks it at start-up). */
  readonly oneSignal: { readonly appId: string; readonly restApiKey: string } | null
  readonly fetch: typeof fetch
  readonly log?: PushProviderLog
  readonly record?: (payload: OneSignalPushPayload) => void
}

export function createPushProvider(options: CreatePushProviderOptions): PushProvider {
  switch (options.provider) {
    case 'fake':
      return createFakePushProvider({
        env: options.env,
        ...(options.log === undefined ? {} : { log: options.log }),
        ...(options.record === undefined ? {} : { record: options.record }),
      })
    case 'onesignal':
      if (options.oneSignal === null) throw new Error('The OneSignal sender needs its keys.')
      return createOneSignalPushProvider({ ...options.oneSignal, fetch: options.fetch })
  }
}
