import { parseLocalDate, type LocalDate } from '@/shared/lib/dates'

/** On a phone the day shows at most two staff columns side by side (phase 1 §1.4). */
export const MAX_COLUMNS = 2

/** The member's own column first, then the next staff members in the business's order. */
export function defaultColumns(
  activeStaffIds: readonly string[],
  ownStaffId: string | null,
  max = MAX_COLUMNS,
): string[] {
  const own = ownStaffId && activeStaffIds.includes(ownStaffId) ? [ownStaffId] : []
  return [...own, ...activeStaffIds.filter((id) => id !== ownStaffId)].slice(0, max)
}

/**
 * Tapping a staff chip: a shown column hides (never the last one); a hidden one is added on the
 * right, and when the screen is full the oldest choice makes room.
 */
export function toggleColumn(
  selected: readonly string[],
  staffId: string,
  max = MAX_COLUMNS,
): string[] {
  if (selected.includes(staffId)) {
    return selected.length > 1 ? selected.filter((id) => id !== staffId) : [...selected]
  }
  const next = [...selected, staffId]
  return next.slice(Math.max(0, next.length - max))
}

/** `?date=` of the day view, or null when it is missing or not a calendar date. */
export function parseDateParam(value: string | null): LocalDate | null {
  if (!value) return null
  try {
    parseLocalDate(value)
    return value
  } catch {
    return null
  }
}
