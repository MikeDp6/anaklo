/**
 * The Intl-only part of the time rules (CLAUDE.md rule 6; `dates.ts` re-exports all of it):
 * - instants are UTC `Date`s (timestamptz in the database);
 * - wall-clock values belong to `businesses.timezone` and are passed around as plain strings;
 * - no function here ever falls back to the machine's time zone or a hard-coded one.
 *
 * No date-fns and no `@date-fns/tz` (which has module side effects, so importing it at all
 * ships it): the booking page imports this module directly and stays inside its size budget
 * (phase 1 §1.3, tactic 1). `dates.test.ts` covers it through `dates.ts`.
 */

/** A calendar date in a business's time zone, `yyyy-MM-dd`. */
export type LocalDate = string
/** A wall-clock time in a business's time zone, `HH:mm`. */
export type LocalTime = string

export type AppLocale = 'el' | 'en'

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export function assertTimeZone(zone: string): void {
  if (!isValidTimeZone(zone)) throw new RangeError(`Unknown time zone: ${zone}`)
}

export function parseLocalDate(date: LocalDate): [number, number, number] {
  const match = LOCAL_DATE.exec(date)
  if (!match) throw new RangeError(`Expected yyyy-MM-dd, got ${date}`)
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  // Reject dates that would silently roll over (2026-13-01, 2026-02-30).
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError(`Not a calendar date: ${date}`)
  }
  return [year, month, day]
}

export function parseLocalTime(time: LocalTime): [number, number] {
  const match = LOCAL_TIME.exec(time)
  if (!match) throw new RangeError(`Expected HH:mm, got ${time}`)
  return [Number(match[1]), Number(match[2])]
}

const WALL_CLOCKS = new Map<string, Intl.DateTimeFormat>()

/** Year, month, day, hour and minute of `instant` on the wall clock of `zone`. */
function wallClock(instant: Date, zone: string): Record<string, string> {
  assertTimeZone(zone)
  let formatter = WALL_CLOCKS.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    WALL_CLOCKS.set(zone, formatter)
  }
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value
  return parts
}

/** The calendar date of `instant` as seen in `zone`. */
export function toLocalDate(instant: Date, zone: string): LocalDate {
  const { year = '', month = '', day = '' } = wallClock(instant, zone)
  return `${year.padStart(4, '0')}-${month}-${day}`
}

/** The wall-clock time of `instant` as seen in `zone`. */
export function toLocalTime(instant: Date, zone: string): LocalTime {
  const { hour = '', minute = '' } = wallClock(instant, zone)
  return `${hour}:${minute}`
}

/** Calendar arithmetic on local dates (never 24-hour steps, which break across DST). */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = parseLocalDate(date)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

/** 0 = Sunday … 6 = Saturday, the same convention as `working_hours.weekday`. */
export function weekdayOf(date: LocalDate): number {
  const [year, month, day] = parseLocalDate(date)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * Formats a calendar date (already local to the business, so no zone is involved) with `Intl`,
 * e.g. `{ weekday: 'short' }` → «Πέμ». Never shifts the day on any device.
 */
export function formatLocalDate(
  date: LocalDate,
  locale: AppLocale,
  options: Intl.DateTimeFormatOptions,
): string {
  const [year, month, day] = parseLocalDate(date)
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  )
}

/** Formats `instant` in `zone` with `Intl` options (times as 24h `HH:mm` with `hourCycle`). */
export function formatInstant(
  instant: Date,
  zone: string,
  locale: AppLocale,
  options: Intl.DateTimeFormatOptions,
): string {
  assertTimeZone(zone)
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }).format(instant)
}
