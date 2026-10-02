/**
 * Local wall-clock hours of a shop (SPEC §7): weekdays, 'HH:MM' times and intervals of one day.
 * Pure (no Deno/npm): shared by the pro app's forms and the provisioning script, so the same
 * day of hours is validated the same way everywhere. The database stays the source of truth
 * (working_hours_no_overlap, schedule_exceptions_no_overlap).
 */

/** Keys of a week, mapped to working_hours.weekday (extract(dow): 0 = Sunday). */
export const WEEKDAYS = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 0,
} as const

export type WeekdayKey = keyof typeof WEEKDAYS

/** Monday first, as the week is shown. */
export const WEEKDAY_KEYS: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/** A local time of day as the UI and the provisioning file write it: 00:00–23:59. */
export const HOUR_MINUTE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 'HH:MM' (also '24:00', the end of a day as the database may store it) or 'HH:MM:SS…'. */
const DB_TIME = /^(?:([01]\d|2[0-3]):([0-5]\d)|(24):(00))(?::[0-5]\d(?:\.\d+)?)?$/

export interface HmInterval {
  start: string
  end: string
}

/** Minutes since local midnight: '09:30' → 570, '24:00' → 1440. */
export function minutesOf(hm: string): number {
  const match = DB_TIME.exec(hm)
  if (!match) throw new TypeError(`Expected a time "HH:MM", got ${JSON.stringify(hm)}`)
  const hours = Number(match[1] ?? match[3])
  const minutes = Number(match[2] ?? match[4])
  return hours * 60 + minutes
}

/** A Postgres `time` as 'HH:MM': '09:00:00' → '09:00', '24:00:00' → '24:00'. */
export function toHm(dbTime: string): string {
  if (!DB_TIME.test(dbTime)) {
    throw new TypeError(`Expected a database time, got ${JSON.stringify(dbTime)}`)
  }
  return dbTime.slice(0, 5)
}

/** '09:00-14:00' → { start: '09:00', end: '14:00' }. Only for strings that were validated. */
export function parseInterval(text: string): HmInterval {
  const [start = '', end = ''] = text.split('-')
  return { start, end }
}

/**
 * Pairs [earlier, later] of intervals (indexes into `intervals`) that overlap on one day.
 * Back-to-back intervals (09:00–14:00, 14:00–18:00) do not overlap, as in the database ('[)').
 * Expects valid times with end > start.
 */
export function findOverlaps(intervals: readonly HmInterval[]): [number, number][] {
  const sorted = intervals
    .map((interval, index) => ({
      index,
      start: minutesOf(interval.start),
      end: minutesOf(interval.end),
    }))
    .sort((a, b) => a.start - b.start || a.index - b.index)
  const overlaps: [number, number][] = []
  let latest = sorted[0]
  for (const current of sorted.slice(1)) {
    if (!latest) break
    if (current.start < latest.end) overlaps.push([latest.index, current.index])
    if (current.end > latest.end) latest = current
  }
  return overlaps
}
