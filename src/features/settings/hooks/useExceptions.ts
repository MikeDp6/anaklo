import { useQuery } from '@tanstack/react-query'
import type { LocalDate } from '@/shared/lib/dates'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { addExceptions, deleteExceptions, fetchExceptions } from '../api'
import { invalidateExceptions } from '../invalidate'
import type { NewException } from '../schema'

/** Closures and special hours from `fromDate` (business-local today) on. */
export function useExceptions(businessId: string, fromDate: LocalDate) {
  return useQuery({
    queryKey: proKeys.exceptions(businessId, fromDate),
    queryFn: ({ signal }) => fetchExceptions(businessId, fromDate, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

/** One bulk insert of a closure's rows (client-generated ids: a retry inserts nothing). */
export function useAddExceptions(businessId: string) {
  return useSettingsMutation<readonly NewException[], void>({
    mutationFn: (rows) => addExceptions(businessId, rows),
    invalidate: (queryClient) => invalidateExceptions(queryClient, businessId),
  })
}

/** Deletes every row of a grouped item in one call. */
export function useDeleteExceptions(businessId: string) {
  return useSettingsMutation<readonly string[], void>({
    mutationFn: (ids) => deleteExceptions(businessId, ids),
    invalidate: (queryClient) => invalidateExceptions(queryClient, businessId),
  })
}
