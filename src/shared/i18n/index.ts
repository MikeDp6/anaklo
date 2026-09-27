import i18next, { type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Locale } from '@/shared/lib/domain'
import el from './el.json'

export const DEFAULT_LOCALE: Locale = 'el'

/**
 * Greek ships inline (it is the default and the booking page must stay small);
 * English is fetched only when needed.
 */
export async function initI18n(locale: Locale = DEFAULT_LOCALE): Promise<i18n> {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      lng: DEFAULT_LOCALE,
      fallbackLng: DEFAULT_LOCALE,
      resources: { el: { translation: el } },
      interpolation: { escapeValue: false },
    })
  }
  await setLocale(locale)
  return i18next
}

export async function setLocale(locale: Locale): Promise<void> {
  if (locale === 'en' && !i18next.hasResourceBundle('en', 'translation')) {
    const en = await import('./en.json')
    i18next.addResourceBundle('en', 'translation', en.default)
  }
  await i18next.changeLanguage(locale)
  document.documentElement.lang = locale
}
