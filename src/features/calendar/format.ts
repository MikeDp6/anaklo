import { useTranslation } from 'react-i18next'
import { formatInstant, formatLocalDate, type AppLocale, type LocalDate } from '@/shared/lib/dates'
import { formatMoney } from '@/shared/lib/money'

/**
 * Display helpers of the pro app. Every instant is shown in the business zone (dates.ts), every
 * amount through money.ts (rule 5); nothing here reads the device's zone.
 */

export function useAppLocale(): AppLocale {
  const { i18n } = useTranslation()
  return i18n.resolvedLanguage === 'en' ? 'en' : 'el'
}

/** «09:30» of an instant, in the business zone. */
export function formatTime(instant: string | Date, timeZone: string, locale: AppLocale): string {
  return formatInstant(
    typeof instant === 'string' ? new Date(instant) : instant,
    timeZone,
    locale,
    {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    },
  )
}

/** «Τρίτη 29 Σεπτεμβρίου» of a business-local date. */
export function formatLongDate(date: LocalDate, locale: AppLocale): string {
  return formatLocalDate(date, locale, { weekday: 'long', day: 'numeric', month: 'long' })
}

/** «Τρί 29 Σεπ». */
export function formatShortDate(date: LocalDate, locale: AppLocale): string {
  return formatLocalDate(date, locale, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** «Τρί» + «29» for a date chip. */
export function dayParts(date: LocalDate, locale: AppLocale) {
  return {
    weekday: formatLocalDate(date, locale, { weekday: 'short' }),
    day: formatLocalDate(date, locale, { day: 'numeric' }),
  }
}

export function formatPrice(cents: number, currency: string, locale: AppLocale): string {
  return formatMoney(cents, currency, locale)
}
