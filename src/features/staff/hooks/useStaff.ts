import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { fetchStaff } from '../api'

export function useStaff(businessId: string) {
  return useQuery({
    queryKey: proKeys.staff(businessId),
    queryFn: ({ signal }) => fetchStaff(businessId, signal),
    staleTime: 5 * 60_000,
  })
}
