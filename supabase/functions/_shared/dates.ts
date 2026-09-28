import { TZDate, tzOffset } from '@date-fns/tz'
import { format } from 'date-fns'
import { el, enUS, type Locale } from 'date-fns/locale'
import {
  assertTimeZone,
  parseLocalDate,
  parseLocalTime,
  type AppLocale,
  type LocalDate,
  type LocalTime,
} from './local-dates.ts'

/**
 * Time rules (CLAUDE.md rule 6): everything of `local-dates.ts` (Intl only) plus the two
 * functions that need date-fns. DST behaviour matches PostgreSQL `AT TIME ZONE`: a local time
 * that does not exist (spring forward) moves forward by the gap; an ambiguous one (fall back)
 * resolves to standard time.
 *
 * The booking page imports `local-dates.ts` directly (via `@/shared/lib/localDates`), never this
 * module: `@date-fns/tz` has module side effects and would ship with any import of it.
 */
export * from './local-dates.ts'

const DATE_FNS_LOCALES: Record<AppLocale, Locale> = { el, en: enUS }

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

/** Formats `instant` in `zone` with a date-fns pattern and the app locale (SMS texts). */
export function formatInZone(
  instant: Date,
  zone: string,
  pattern: string,
  locale: AppLocale,
): string {
  assertTimeZone(zone)
  return format(new TZDate(instant, zone), pattern, { locale: DATE_FNS_LOCALES[locale] })
}
