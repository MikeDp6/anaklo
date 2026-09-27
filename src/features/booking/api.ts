import { callPublicRpc } from '@/shared/lib/publicApi'
import { PublicProfileRows, type PublicProfile } from './schema'

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
