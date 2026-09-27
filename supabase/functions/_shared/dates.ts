import { TZDate, tzOffset } from '@date-fns/tz'
import { format } from 'date-fns'
import { el, enUS, type Locale } from 'date-fns/locale'

/**
 * Time rules (CLAUDE.md rule 6):
 * - instants are UTC `Date`s (timestamptz in the database);
 * - wall-clock values belong to `businesses.timezone` and are passed around as plain strings;
 * - no function here ever falls back to the machine's time zone or a hard-coded one.
 *
 * DST behaviour matches PostgreSQL `AT TIME ZONE`: a local time that does not exist (spring
 * forward) moves forward by the gap; an ambiguous one (fall back) resolves to standard time.
 */

/** A calendar date in a business's time zone, `yyyy-MM-dd`. */
export type LocalDate = string
/** A wall-clock time in a business's time zone, `HH:mm`. */
export type LocalTime = string

export type AppLocale = 'el' | 'en'

const DATE_FNS_LOCALES: Record<AppLocale, Locale> = { el, en: enUS }
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

function assertTimeZone(zone: string): void {
  if (!isValidTimeZone(zone)) throw new RangeError(`Unknown time zone: ${zone}`)
}

function parseLocalDate(date: LocalDate): [number, number, number] {
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

function parseLocalTime(time: LocalTime): [number, number] {
  const match = LOCAL_TIME.exec(time)
  if (!match) throw new RangeError(`Expected HH:mm, got ${time}`)
  return [Number(match[1]), Number(match[2])]
}

/** The calendar date of `instant` as seen in `zone`. */
export function toLocalDate(instant: Date, zone: string): LocalDate {
  assertTimeZone(zone)
  return format(new TZDate(instant, zone), 'yyyy-MM-dd')
}

/** The wall-clock time of `instant` as seen in `zone`. */
export function toLocalTime(instant: Date, zone: string): LocalTime {
  assertTimeZone(zone)
  return format(new TZDate(instant, zone), 'HH:mm')
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/**
 * The instant at which the wall clock in `zone` shows `date` `time`.
 * Computed from UTC fields and zone offsets only, so the result never depends on the time zone
 * of the device running it (TZDate's wall-clock constructor does). Matches PostgreSQL:
 * - ambiguous (fall back): the offset after the change, i.e. standard time;
 * - non-existent (spring forward): the offset before the change, i.e. moved forward by the gap.
 */
export function localDateTimeToInstant(date: LocalDate, time: LocalTime, zone: string): Date {
  assertTimeZone(zone)
  const [year, month, day] = parseLocalDate(date)
  const [hours, minutes] = parseLocalTime(time)
  const wall = Date.UTC(year, month - 1, day, hours, minutes)
  const offsetBefore = tzOffset(zone, new Date(wall - DAY_MS))
  const offsetAfter = tzOffset(zone, new Date(wall + DAY_MS))
  const withOffsetAfter = wall - offsetAfter * MINUTE_MS
  if (tzOffset(zone, new Date(withOffsetAfter)) === offsetAfter) return new Date(withOffsetAfter)
  return new Date(wall - offsetBefore * MINUTE_MS)
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

/** Formats `instant` in `zone` with a date-fns pattern and the app locale. */
export function formatInZone(
  instant: Date,
  zone: string,
  pattern: string,
  locale: AppLocale,
): string {
  assertTimeZone(zone)
  return format(new TZDate(instant, zone), pattern, { locale: DATE_FNS_LOCALES[locale] })
}
