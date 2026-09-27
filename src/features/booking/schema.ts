import { z } from 'zod/mini'
import { Locale, Vertical } from '@/shared/lib/domain'

export const PublicProfile = z.object({
  slug: z.string(),
  name: z.string(),
  vertical: Vertical,
  timezone: z.string(),
  locale: Locale,
  theme: z.unknown(),
})

/** The RPC returns a set: zero rows (unknown or hidden business) or one. */
export const PublicProfileRows = z.array(PublicProfile).check(z.maxLength(1))

export type PublicProfile = z.infer<typeof PublicProfile>
