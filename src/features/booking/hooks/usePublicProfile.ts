import { useQuery } from '@tanstack/react-query'
import { fetchPublicProfile } from '../api'

export function usePublicProfile(slug: string) {
  return useQuery({
    queryKey: ['public-profile', slug],
    queryFn: ({ signal }) => fetchPublicProfile(slug, signal),
    staleTime: 5 * 60_000,
  })
}
