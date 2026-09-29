import type { LocalDate } from '@/shared/lib/dates'
import { canReadAppointmentDetails } from '../access'
import { failedRefresh, failedWithoutData } from '../queryState'
import type { DayColumnModel } from '../components/DayColumn'
import type { DayFrame } from '../schema'
import { useStaffDays } from './useDayQueries'
import type { Workspace } from './useWorkspace'

/**
 * The chosen columns of the day: a column the member may read comes from its RLS query (one per
 * staff member, per day: the keys Realtime will refresh in Phase 3), the others from the busy
 * blocks of `busy_calendar`.
 */
export function useDayColumns(
  workspace: Workspace,
  date: LocalDate,
  selectedIds: readonly string[],
  frame: DayFrame | undefined,
) {
  const { membership, businessId, business } = workspace
  const readableIds = selectedIds.filter((id) => canReadAppointmentDetails(membership, id))
  const days = useStaffDays(businessId, date, readableIds, business.timeZone)
  // A column that never loaded blocks the grid; one whose refetch failed keeps its appointments.
  const failed = days.find(failedWithoutData)
  const stale = days.find(failedRefresh)

  const columns: DayColumnModel[] = selectedIds.flatMap((id) => {
    const staff = workspace.staff.find((member) => member.id === id)
    if (!staff) return []
    const readable = readableIds.includes(id)
    const day = readable ? days[readableIds.indexOf(id)] : undefined
    return [
      {
        staff,
        readable,
        appointments: readable ? (day?.data ?? null) : null,
        blocks: frame?.blocks.filter((block) => block.staffId === id) ?? [],
        windows: frame?.windows.filter((window) => window.staffId === id) ?? [],
      },
    ]
  })

  return {
    columns,
    /** A column that could not load at all. */
    failure: failed?.error ?? null,
    /** A column whose last refresh failed (it still shows what loaded before). */
    refreshFailure: stale?.error ?? null,
    retry: () => {
      for (const day of days) if (day.isError) void day.refetch()
    },
  }
}
