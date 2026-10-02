import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { fetchStaff } from '../api'

/** Active and inactive staff (contract 1.6 §3.3: 60″, refetched on focus). */
export function useStaff(businessId: string) {
  return useQuery({
    queryKey: proKeys.staff(businessId),
    queryFn: ({ signal }) => fetchStaff(businessId, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}
