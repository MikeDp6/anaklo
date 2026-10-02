import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { fetchReassignCandidates, fetchScheduleConflicts } from '../api'
import type { ConflictsQuery } from '../schema'

/**
 * Appointments that need a change (contract 1.6 §3.3: refetched on mount and focus, no interval).
 * `enabled: false` for a window that is already over.
 */
export function useScheduleConflicts(businessId: string, query: ConflictsQuery, enabled = true) {
  return useQuery({
    queryKey: proKeys.conflicts(businessId, query),
    queryFn: ({ signal }) => fetchScheduleConflicts(businessId, query, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
    enabled,
  })
}

/** Which colleagues are free at the appointment's time (asked while its row is on screen). */
export function useReassignCandidates(businessId: string, appointmentId: string, enabled = true) {
  return useQuery({
    queryKey: proKeys.reassign(businessId, appointmentId),
    queryFn: ({ signal }) => fetchReassignCandidates(businessId, appointmentId, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
    enabled,
  })
}
