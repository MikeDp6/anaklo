import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { fetchServices } from '../api'

export function useServices(businessId: string) {
  return useQuery({
    queryKey: proKeys.services(businessId),
    queryFn: ({ signal }) => fetchServices(businessId, signal),
    staleTime: 5 * 60_000,
  })
}
