import { z } from 'zod/mini'
import { themeVariables } from '../src/shared/lib/theme.ts'
import type { FetchLike } from './api-proxy.ts'
import type { BookingShellData } from './inject.ts'

/**
 * The data injected into `/<slug>` (ADR-0008 §5). Step 1.1 reads `public_business_profile`
 * (Phase 0); from 1.3 `public_booking_catalogue`. Called directly on Supabase with the
 * publishable key (not through `/api`), by the Worker and by the Vite dev server.
 */

export type ShellSupabaseEnv = { SUPABASE_URL: string; SUPABASE_PUBLISHABLE_KEY: string }

export type BookingShellLookup =
  { kind: 'found'; data: BookingShellData } | { kind: 'not-found' } | { kind: 'unavailable' }

/** Slower answers serve the plain shell; the page then loads the profile itself. */
export const PROFILE_TIMEOUT_MS = 3000

/** The RPC's row as the Worker needs it; the booking page validates it again, fully. */
const ProfileRow = z.object({
  slug: z.string(),
  name: z.string(),
  vertical: z.string(),
  timezone: z.string(),
  locale: z.string(),
  theme: z.unknown(),
})

const ProfileRows = z.array(ProfileRow).check(z.maxLength(1))

export type InitialBookingData = { profile: z.infer<typeof ProfileRow> }

export async function lookupBookingShell(
  slug: string,
  env: ShellSupabaseEnv,
  fetchImpl: FetchLike,
  origin?: string,
): Promise<BookingShellLookup> {
  let rows: z.infer<typeof ProfileRows>
  try {
    const response = await fetchImpl(
      `${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/public_business_profile`,
      {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ p_slug: slug }),
        signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      },
    )
    if (!response.ok) return { kind: 'unavailable' }
    const parsed = ProfileRows.safeParse(await response.json())
    if (!parsed.success) return { kind: 'unavailable' }
    rows = parsed.data
  } catch {
    return { kind: 'unavailable' }
  }

  const profile = rows[0]
  if (!profile) return { kind: 'not-found' }
  const initial: InitialBookingData = { profile }
  return {
    kind: 'found',
    data: {
      title: profile.name,
      url: origin ? `${origin}/${profile.slug}` : undefined,
      themeColor: themeVariables(profile.theme)['--color-brand'],
      lang: profile.locale,
      initial,
    },
  }
}
