import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { fetchCategories, fetchServiceCatalogue } from '../api'

/** Active and inactive services with their staff terms (contract 1.6 §3.3: 60″, on focus). */
export function useServiceCatalogue(businessId: string) {
  return useQuery({
    queryKey: proKeys.serviceCatalogue(businessId),
    queryFn: ({ signal }) => fetchServiceCatalogue(businessId, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

/** The provisioned categories. */
export function useCategories(businessId: string) {
  return useQuery({
    queryKey: proKeys.categories(businessId),
    queryFn: ({ signal }) => fetchCategories(businessId, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}
