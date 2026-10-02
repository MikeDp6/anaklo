import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { fetchMembers } from '../api'

/** The members of the business with their emails (contract 1.7 §6.10: 60″ fresh, on focus). */
export function useMembers(businessId: string) {
  return useQuery({
    queryKey: proKeys.members(businessId),
    queryFn: ({ signal }) => fetchMembers(businessId, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}
