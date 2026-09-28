import i18next, { type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Locale } from '@/shared/lib/domain'

export const DEFAULT_LOCALE: Locale = 'el'

/**
 * Catalogues per namespace (ADR-0011 / phase 1 §1.3): `common` (both apps: app name, retry,
 * loading, errors.*), `booking` (booking page), `pro` (professional app). Each entry passes its
 * own CatalogueSet (./booking.ts, ./pro.ts), so the booking page never bundles the pro texts.
 */
export const NAMESPACES = ['common', 'booking', 'pro'] as const
export type Namespace = (typeof NAMESPACES)[number]

export type Catalogue = { readonly [key: string]: unknown }
export type Catalogues = { readonly common: Catalogue } & {
  readonly [N in Exclude<Namespace, 'common'>]?: Catalogue
}

export interface CatalogueSet {
  /** Greek, bundled with the entry: it is the default and the page must render without a fetch. */
  readonly el: Catalogues
  /** English, loaded in a separate chunk only when a page switches to it. */
  readonly loadEn: () => Promise<Catalogues>
}

let loadEnglish: CatalogueSet['loadEn'] | null = null

function present(catalogues: Catalogues): [Namespace, Catalogue][] {
  return NAMESPACES.flatMap((ns): [Namespace, Catalogue][] => {
    const catalogue = catalogues[ns]
    return catalogue ? [[ns, catalogue]] : []
  })
}

export async function initI18n(
  catalogues: CatalogueSet,
  locale: Locale = DEFAULT_LOCALE,
): Promise<i18n> {
  loadEnglish = catalogues.loadEn
  if (!i18next.isInitialized) {
    const greek = present(catalogues.el)
    await i18next.use(initReactI18next).init({
      lng: DEFAULT_LOCALE,
      fallbackLng: DEFAULT_LOCALE,
      ns: greek.map(([ns]) => ns),
      defaultNS: 'common',
      resources: { [DEFAULT_LOCALE]: Object.fromEntries(greek) },
      interpolation: { escapeValue: false },
    })
  }
  await setLocale(locale)
  return i18next
}

export async function setLocale(locale: Locale): Promise<void> {
  if (locale === 'en' && loadEnglish && !i18next.hasResourceBundle('en', 'common')) {
    for (const [ns, catalogue] of present(await loadEnglish())) {
      i18next.addResourceBundle('en', ns, catalogue)
    }
  }
  await i18next.changeLanguage(locale)
  document.documentElement.lang = locale
}
