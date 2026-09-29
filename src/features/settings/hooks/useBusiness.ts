import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { fetchBusiness } from '../api'

/** Name, time zone, currency and the booking settings the day screens need. */
export function useBusiness(businessId: string) {
  return useQuery({
    queryKey: proKeys.business(businessId),
    queryFn: ({ signal }) => fetchBusiness(businessId, signal),
    staleTime: 5 * 60_000,
  })
}
