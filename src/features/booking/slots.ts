import { addLocalDays, type LocalDate } from '@/shared/lib/localDates'

/** `available_slots` answers at most 14 local days per call (0004): the strip shows one window. */
export const WINDOW_DAYS = 14

export interface DateWindow {
  from: LocalDate
  to: LocalDate
  dates: LocalDate[]
  hasEarlier: boolean
  hasLater: boolean
}

/** Window `index` of the bookable range today … today + `maxAdvanceDays` (business-local dates). */
export function dateWindow(today: LocalDate, index: number, maxAdvanceDays: number): DateWindow {
  const last = addLocalDays(today, Math.max(0, maxAdvanceDays))
  const from = addLocalDays(today, Math.max(0, index) * WINDOW_DAYS)
  const end = addLocalDays(from, WINDOW_DAYS - 1)
  const to = end < last ? end : last
  const dates: LocalDate[] = []
  for (let date = from; date <= to; date = addLocalDays(date, 1)) dates.push(date)
  return { from, to, dates, hasEarlier: index > 0, hasLater: to < last }
}

export function groupByDate<T extends { local_date: string }>(
  slots: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const slot of slots) {
    const list = groups.get(slot.local_date)
    if (list) list.push(slot)
    else groups.set(slot.local_date, [slot])
  }
  return groups
}

/**
 * AN001 (the time was just taken): the `count` free starts closest to it, in time order.
 * The taken start itself is never offered again, even if a stale answer still lists it.
 */
export function nearestSlots<T extends { starts_at: string }>(
  slots: readonly T[],
  taken: string,
  count: number,
): T[] {
  const target = Date.parse(taken)
  return slots
    .filter((slot) => Date.parse(slot.starts_at) !== target)
    .map((slot) => ({ slot, distance: Math.abs(Date.parse(slot.starts_at) - target) }))
    .sort((a, b) => a.distance - b.distance || a.slot.starts_at.localeCompare(b.slot.starts_at))
    .slice(0, count)
    .map(({ slot }) => slot)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
}
