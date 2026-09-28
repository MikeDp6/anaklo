/**
 * Push notification texts for staff (ADR-0010 §6), in the recipient's language.
 * A documented exception to CLAUDE.md rule 8, like `sms-templates.ts` (ADR-0007): Edge
 * Functions (Deno) send them and do not load the web i18n catalogues.
 *
 * Content is the minimum the professional needs (ADR-0010 §2): never phone numbers, notes or
 * amounts. Dates and times are formatted in `businesses.timezone` via `dates.ts` by the caller.
 * Unlike SMS, push is not GSM-7: texts are written normally (lower case, accents).
 */
export type PushLocale = 'el' | 'en'

export const PUSH_LOCALES: readonly PushLocale[] = ['el', 'en']

export type PushTemplate = { readonly title: string; readonly body: string }

/** Lock screens cut longer texts; push-templates.test.ts keeps every template within them. */
export const PUSH_TITLE_MAX = 50
export const PUSH_BODY_MAX = 150

export const PUSH_TEMPLATES = {
  /** The device test of step 1.1 (`spike-push`); removed with it at the latest in 1.5a. */
  spike_test: {
    el: {
      title: 'Δοκιμαστική ειδοποίηση',
      body: 'Αν το βλέπεις, οι ειδοποιήσεις λειτουργούν σε αυτή τη συσκευή.',
    },
    en: {
      title: 'Test notification',
      body: 'If you can see this, notifications work on this device.',
    },
  },
} as const satisfies Record<string, Record<PushLocale, PushTemplate>>

export type PushTemplateKey = keyof typeof PUSH_TEMPLATES

const PLACEHOLDER = /\{\{(\w+)\}\}/g

export function pushTemplateVariables(key: PushTemplateKey, locale: PushLocale): string[] {
  const { title, body } = PUSH_TEMPLATES[key][locale]
  const found = new Set<string>()
  for (const match of `${title}\n${body}`.matchAll(PLACEHOLDER)) {
    if (match[1] !== undefined) found.add(match[1])
  }
  return [...found].sort()
}

function fill(text: string, key: PushTemplateKey, values: Readonly<Record<string, string>>) {
  return text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`Push template ${key} needs {{${name}}}`)
    return value
  })
}

export function renderPush(
  key: PushTemplateKey,
  locale: PushLocale,
  values: Readonly<Record<string, string>> = {},
): PushTemplate {
  const template = PUSH_TEMPLATES[key][locale]
  return { title: fill(template.title, key, values), body: fill(template.body, key, values) }
}

/** Every language at once, for providers that pick the text on the device (OneSignal). */
export function renderPushAllLocales(
  key: PushTemplateKey,
  values: Readonly<Record<string, string>> = {},
): Record<PushLocale, PushTemplate> {
  return { el: renderPush(key, 'el', values), en: renderPush(key, 'en', values) }
}
