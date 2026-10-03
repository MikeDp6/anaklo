import { formatLocalDate, type AppLocale, type LocalDate } from '@/shared/lib/dates'

/**
 * Dates of the client card. A card spans years (history, «Πελάτης από»), so its dates carry the
 * year: «Τρί 29 Σεπ 2026». Business-local dates only (the server gives them, or `toLocalDate` in
 * the business zone made them), never the device's zone (rule 6).
 */
export function formatCardDate(date: LocalDate, locale: AppLocale): string {
  return formatLocalDate(date, locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
