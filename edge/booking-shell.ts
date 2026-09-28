import { z } from 'zod/mini'
import elBooking from '../src/shared/i18n/el/booking.json' with { type: 'json' }
import enBooking from '../src/shared/i18n/en/booking.json' with { type: 'json' }
import { themeVariables } from '../src/shared/lib/theme.ts'
import type { FetchLike } from './api-proxy.ts'
import type { BookingShellData } from './inject.ts'

/**
 * The data injected into `/<slug>` (ADR-0008 §5): `public_booking_catalogue` (1.3), so the page
 * renders without a first round trip, plus `/r/<code>` → slug. Called directly on Supabase with
 * the publishable key (not through `/api`), by the Worker and by the Vite dev server. The Worker
 * has no texts of its own: the Open Graph description comes from the `booking` catalogue.
 */

export type ShellSupabaseEnv = { SUPABASE_URL: string; SUPABASE_PUBLISHABLE_KEY: string }

export type BookingShellLookup =
  { kind: 'found'; data: BookingShellData } | { kind: 'not-found' } | { kind: 'unavailable' }

export type ShortLinkLookup =
  { kind: 'found'; slug: string } | { kind: 'not-found' } | { kind: 'unavailable' }

/** Slower answers serve the plain shell; the page then loads the catalogue itself. */
export const PROFILE_TIMEOUT_MS = 3000

/** What the Worker needs of the catalogue; the booking page validates the whole of it again. */
const CatalogueHead = z.object({
  business: z.object({
    slug: z.string(),
    name: z.string(),
    locale: z.string(),
    theme: z.unknown(),
  }),
})

export type InitialBookingData = { catalogue: unknown }

const DESCRIPTIONS: Record<string, string> = {
  el: elBooking.og.description,
  en: enBooking.og.description,
}

/** `og.description` of the business's language, with its name (a plain `{{name}}` slot). */
export function shareDescription(locale: string, name: string): string {
  const template = DESCRIPTIONS[locale] ?? elBooking.og.description
  return template.replace('{{name}}', () => name)
}

async function callRpc(
  name: string,
  args: Record<string, unknown>,
  env: ShellSupabaseEnv,
  fetchImpl: FetchLike,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const response = await fetchImpl(
      `${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${name}`,
      {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      },
    )
    if (!response.ok) return { ok: false }
    return { ok: true, body: await response.json() }
  } catch {
    return { ok: false }
  }
}

export async function lookupBookingShell(
  slug: string,
  env: ShellSupabaseEnv,
  fetchImpl: FetchLike,
  origin?: string,
): Promise<BookingShellLookup> {
  const answer = await callRpc('public_booking_catalogue', { p_slug: slug }, env, fetchImpl)
  if (!answer.ok) return { kind: 'unavailable' }
  if (answer.body === null) return { kind: 'not-found' }
  const parsed = CatalogueHead.safeParse(answer.body)
  if (!parsed.success) return { kind: 'unavailable' }

  const { business } = parsed.data
  const initial: InitialBookingData = { catalogue: answer.body }
  return {
    kind: 'found',
    data: {
      title: business.name,
      description: shareDescription(business.locale, business.name),
      url: origin ? `${origin}/${business.slug}` : undefined,
      themeColor: themeVariables(business.theme)['--color-brand'],
      lang: business.locale,
      initial,
    },
  }
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/

/** `/r/<code>` (the SMS short link): the slug of a business with online booking, or not found. */
export async function lookupShortLink(
  code: string,
  env: ShellSupabaseEnv,
  fetchImpl: FetchLike,
): Promise<ShortLinkLookup> {
  const answer = await callRpc('public_slug_for_code', { p_code: code }, env, fetchImpl)
  if (!answer.ok) return { kind: 'unavailable' }
  if (answer.body === null) return { kind: 'not-found' }
  return typeof answer.body === 'string' && SLUG.test(answer.body)
    ? { kind: 'found', slug: answer.body }
    : { kind: 'unavailable' }
}
