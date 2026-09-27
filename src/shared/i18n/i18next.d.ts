import 'i18next'
import type el from './el.json'

// Translation keys are checked at compile time against the Greek catalogue.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: typeof el }
  }
}
