import { z } from 'zod/mini'
import { callPublicRpc } from '@/shared/lib/publicApi'
import { INITIAL_DATA_ELEMENT_ID } from '../../../edge/inject.ts'
import { PublicProfile, PublicProfileRows } from './schema'

export async function fetchPublicProfile(
  slug: string,
  signal?: AbortSignal,
): Promise<PublicProfile | null> {
  const rows = await callPublicRpc(
    'public_business_profile',
    { p_slug: slug },
    PublicProfileRows,
    signal,
  )
  return rows[0] ?? null
}

const InitialBookingData = z.object({ profile: PublicProfile })

/**
 * The profile the Worker injected into `/<slug>` (ADR-0008 §5), validated like a fetched one,
 * so the page renders without a second round trip. Missing, stale or invalid → `undefined`,
 * and the page fetches it instead.
 */
export function readInitialProfile(slug: string): PublicProfile | undefined {
  const text = document.getElementById(INITIAL_DATA_ELEMENT_ID)?.textContent
  if (!text) return undefined
  try {
    const parsed = InitialBookingData.safeParse(JSON.parse(text))
    return parsed.success && parsed.data.profile.slug === slug ? parsed.data.profile : undefined
  } catch {
    return undefined
  }
}
