import { useQueries, useQuery } from '@tanstack/react-query'
import type { LocalDate } from '@/shared/lib/dates'
import { proKeys, type SlotsQuery } from '@/shared/lib/proQueryKeys'
import {
  fetchDayFrame,
  fetchStaffDay,
  fetchStaffSlots,
  fetchTodaySummary,
  localDayBounds,
} from '../api'

/**
 * Queries of the day screens (contract 1.4 §3.3). Without Realtime (C2) the day and «Σήμερα»
 * refetch on focus, on reconnect and every 60″ while mounted and visible; there is no placeholder
 * across days (the skeleton shows instead).
 */
export const LIVE_DAY_OPTIONS = {
  staleTime: 0,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  refetchInterval: 60_000,
  refetchIntervalInBackground: false,
} as const

export function useDayFrame(businessId: string, date: LocalDate) {
  return useQuery({
    queryKey: proKeys.dayFrame(businessId, date),
    queryFn: ({ signal }) => fetchDayFrame(businessId, date, signal),
    ...LIVE_DAY_OPTIONS,
  })
}

function staffDayOptions(businessId: string, date: LocalDate, staffId: string, timeZone: string) {
  return {
    queryKey: proKeys.staffDay(businessId, date, staffId),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchStaffDay(businessId, staffId, localDayBounds(date, timeZone), signal),
    ...LIVE_DAY_OPTIONS,
  }
}

/** One column's appointments, read with RLS (only when the member may read them). */
export function useStaffDay(
  businessId: string,
  date: LocalDate,
  staffId: string,
  timeZone: string,
  enabled = true,
) {
  return useQuery({ ...staffDayOptions(businessId, date, staffId, timeZone), enabled })
}

/** The readable columns of the day view, in the order given. */
export function useStaffDays(
  businessId: string,
  date: LocalDate,
  staffIds: readonly string[],
  timeZone: string,
) {
  return useQueries({
    queries: staffIds.map((staffId) => staffDayOptions(businessId, date, staffId, timeZone)),
  })
}

export function useTodaySummary(businessId: string, today: LocalDate) {
  return useQuery({
    queryKey: proKeys.today(businessId, today),
    queryFn: ({ signal }) => fetchTodaySummary(businessId, signal),
    ...LIVE_DAY_OPTIONS,
  })
}

/** Free times of one staff member (quick add and move); no interval, refreshed on AN001. */
export function useStaffSlots(
  businessId: string,
  query: (SlotsQuery & { readonly staffId: string }) | null,
) {
  return useQuery({
    queryKey: query ? proKeys.slots(businessId, query) : ['pro', businessId, 'slots', 'idle'],
    queryFn: ({ signal }) =>
      query ? fetchStaffSlots(businessId, query, signal) : Promise.resolve([]),
    enabled: query !== null,
    staleTime: 0,
  })
}
