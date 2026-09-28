import {
  formatInstant,
  formatLocalDate,
  type AppLocale,
  type LocalDate,
} from '@/shared/lib/localDates'
import { formatMoney } from '@/shared/lib/money'

/**
 * Display helpers of the booking page. Intl only (dates.ts' Intl part, money.ts): no date-fns in
 * the booking chunks. Dates and times are always shown in the business zone.
 */

export function formatPrice(cents: number, currency: string, locale: AppLocale): string {
  return formatMoney(cents, currency, locale)
}

/** «Πέμ» + «1» + «Οκτ» for a date chip. */
export function dayParts(date: LocalDate, locale: AppLocale) {
  return {
    weekday: formatLocalDate(date, locale, { weekday: 'short' }),
    day: formatLocalDate(date, locale, { day: 'numeric' }),
    month: formatLocalDate(date, locale, { month: 'short' }),
  }
}

/** «Πέμπτη 1 Οκτωβρίου» */
export function formatLongDate(date: LocalDate, locale: AppLocale): string {
  return formatLocalDate(date, locale, { weekday: 'long', day: 'numeric', month: 'long' })
}

/** «Πέμ 1 Οκτ»: a day inside a button label. */
export function formatShortDate(date: LocalDate, locale: AppLocale): string {
  return formatLocalDate(date, locale, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** `09:00:00` (Postgres `time`) → `09:00`. */
export function shortTime(localTime: string): string {
  return localTime.slice(0, 5)
}

/** «Πέμπτη 1 Οκτωβρίου» of an instant, in the business zone. */
export function formatInstantDate(instant: string, zone: string, locale: AppLocale): string {
  return formatInstant(new Date(instant), zone, locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

/** «09:00» of an instant, in the business zone. */
export function formatInstantTime(instant: string, zone: string, locale: AppLocale): string {
  return formatInstant(new Date(instant), zone, locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}
