import { addLocalDays, localDateTimeToInstant, toLocalDate } from '@/shared/lib/dates'

const MINUTE_MS = 60_000

/**
 * The window of an urgent absence (contract 1.6 D8, §4.10): from now, floored to the minute, to
 * the next midnight of the business's day (23 or 25 hours long on DST days: calendar arithmetic
 * on the local date, never 24-hour steps). Instants as ISO strings, the shape `mark_absence` takes.
 */
export function absenceWindow(now: Date, timeZone: string): { from: string; to: string } {
  const from = new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS)
  const today = toLocalDate(from, timeZone)
  const to = localDateTimeToInstant(addLocalDays(today, 1), '00:00', timeZone)
  return { from: from.toISOString(), to: to.toISOString() }
}
