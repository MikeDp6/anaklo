import { useQuery } from '@tanstack/react-query'
import { fetchScheduleConflicts } from '@/features/settings/api'
import { proKeys } from '@/shared/lib/proQueryKeys'

/**
 * How many future appointments of one staff member need a change (`schedule_conflicts`, from now
 * to the server's 366-day horizon). The same query (key and rows) as «Ραντεβού που χρειάζονται
 * αλλαγή» for that staff member; only the count is selected here.
 */
export function useStaffConflictCount(businessId: string, staffId: string, enabled: boolean) {
  const query = { staffId, from: null, to: null } as const
  return useQuery({
    queryKey: proKeys.conflicts(businessId, query),
    queryFn: ({ signal }) => fetchScheduleConflicts(businessId, query, signal),
    select: (rows) => rows.length,
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
}
