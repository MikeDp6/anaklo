import 'i18next'
import type booking from './el/booking.json'
import type common from './el/common.json'
import type pro from './el/pro.json'

// Keys are checked at compile time against the Greek catalogues, per namespace:
// `useTranslation()` → common; `useTranslation('pro')` → pro; `useTranslation(['booking',
// 'common'])` → booking keys plain, common keys as `common:<key>`.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: { common: typeof common; booking: typeof booking; pro: typeof pro }
  }
}
