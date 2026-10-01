import { z } from 'zod/mini'
import type { PushLocale, PushTemplate } from './push-templates.ts'

/**
 * OneSignal REST payloads for staff push (ADR-0010 §2). Pure (ADR-0002 §3): no Deno APIs, so
 * `spike-push` (1.1) and `dispatch` (1.5, through `push-provider.ts`) build the same payload and
 * Vitest checks it.
 *
 * A push is addressed ONLY by subscription id (`include_subscription_ids`), never by
 * `external_id` or another alias. OneSignal's Identity Verification supports the mobile SDKs
 * only, not the Web SDK, so on the web an alias is whatever the browser claims: any member
 * could claim the owner's `external_id` from the devtools and receive the owner's pushes. The
 * server decides which subscriptions belong to whom: in 1.1 the calling device itself
 * (`spike-push`), from 1.5 the rows of `push_subscriptions` (written only for `auth.uid()`).
 */
export const ONESIGNAL_NOTIFICATIONS_URL = 'https://api.onesignal.com/notifications?c=push'

/** A OneSignal subscription id (`OneSignal.User.PushSubscription.id`): a UUID. */
export const OneSignalSubscriptionId = z.guid()

/** The body `{ subscription_id }` of a call that names one device's subscription. */
export const SubscriptionIdBody = z.strictObject({ subscription_id: OneSignalSubscriptionId })

export interface OneSignalPushPayload {
  readonly app_id: string
  /** Required by OneSignal together with `include_subscription_ids`. */
  readonly target_channel: 'push'
  readonly include_subscription_ids: readonly string[]
  /** OneSignal picks the text by the device language; `en` is its required fallback. */
  readonly headings: Readonly<Record<PushLocale, string>>
  readonly contents: Readonly<Record<PushLocale, string>>
  /** Opened on tap; absolute. */
  readonly url?: string
}

export function buildPushPayload(input: {
  readonly appId: string
  readonly subscriptionIds: readonly string[]
  readonly texts: Readonly<Record<PushLocale, PushTemplate>>
  readonly url?: string | null
}): OneSignalPushPayload {
  if (input.appId.trim() === '') throw new Error('A push needs the OneSignal app id')
  if (input.subscriptionIds.length === 0) throw new Error('A push needs a subscription id')
  for (const id of input.subscriptionIds) {
    if (!OneSignalSubscriptionId.safeParse(id).success) {
      throw new Error('A push is addressed by OneSignal subscription ids (UUIDs) only')
    }
  }
  const { el, en } = input.texts
  return {
    app_id: input.appId,
    target_channel: 'push',
    include_subscription_ids: [...new Set(input.subscriptionIds)],
    headings: { en: en.title, el: el.title },
    contents: { en: en.body, el: el.body },
    ...(input.url ? { url: input.url } : {}),
  }
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1'])

/**
 * The pro app's `/app/` on `SITE_HOST` (contract 1.5 §3.2), for the tap of a push sent by the
 * server (no request Origin there): plain `http://` only for a local host, `https://` for every
 * other host. `SITE_HOST` is validated at start-up (`booking-config.ts`: host and optional port).
 */
export function appUrl(siteHost: string): string {
  const host = siteHost.trim().toLowerCase()
  const scheme = LOCAL_HOSTS.has(host.replace(/:\d+$/, '')) ? 'http' : 'https'
  return `${scheme}://${host}/app/`
}

/**
 * The pro app's `/app/` on the origin that called, for the tap (OneSignal wants an absolute
 * `url`): `https://dev.anaklo.gr/app/`, or http://localhost when testing locally. Anything else
 * (no Origin, another scheme, plain http on a public host) gets no url. `spike-push` only.
 */
export function pushClickUrl(origin: string | null): string | null {
  if (origin === null) return null
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return null
  }
  const local = LOCAL_HOSTS.has(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return null
  return new URL('/app/', parsed.origin).toString()
}
