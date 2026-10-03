/**
 * Push notification texts for staff (ADR-0010 §6), in the recipient's language.
 * A documented exception to CLAUDE.md rule 8, like `sms-templates.ts` (ADR-0007): Edge
 * Functions (Deno) send them and do not load the web i18n catalogues.
 *
 * Content is the minimum the professional needs (ADR-0010 §2, contract 1.5 D12): the client's
 * FIRST name only, the service, the local date and time, the staff member. Never a phone
 * number, a surname, notes or amounts. Dates and times are formatted in `businesses.timezone`
 * by the caller (`send.ts`, via `dates.ts`). Unlike SMS, push is not GSM-7: texts are written
 * normally (lower case, accents).
 *
 * The keys are the push templates of `messages_log` (`domain.ts` derives its list from them).
 *
 * 1.9 (contract 1.9 §3.5): `push_security_alert` goes to the OWNERS of a business when a member's
 * authenticator device changed without approval. The business name only: never the member, the
 * device or what changed (the email carries that).
 */
export type PushLocale = 'el' | 'en'

export const PUSH_LOCALES: readonly PushLocale[] = ['el', 'en']

export type PushTemplate = { readonly title: string; readonly body: string }

/** Lock screens cut longer texts; push-templates.test.ts keeps every template within them. */
export const PUSH_TITLE_MAX = 50
export const PUSH_BODY_MAX = 150

/**
 * The most characters each variable may take (contract 1.5 §3.2). `send.ts` cuts longer values
 * with `…`; the date is `EEE dd/MM` («Τετ 30/09», "Wed 30/09") and the time `HH:mm`.
 */
export const PUSH_VARIABLE_LIMITS = {
  client: 20,
  service: 32,
  staff: 20,
  date: 9,
  time: 5,
  /** `push_security_alert` (1.9): the business, cut like the others. */
  business: 32,
} as const

export type PushVariable = keyof typeof PUSH_VARIABLE_LIMITS

/** `{{client}}` when the appointment has no client name (a walk-in, an erased client). */
export const PUSH_CLIENT_FALLBACK: Readonly<Record<PushLocale, string>> = {
  el: 'Πελάτης',
  en: 'Client',
}

export const PUSH_TEMPLATES = {
  /** A new ONLINE booking (never one made in the app: SPEC §12). */
  push_booking_created: {
    el: {
      title: 'Νέα κράτηση',
      body: '{{client}} · {{service}} · {{date}} {{time}} με {{staff}}',
    },
    en: {
      title: 'New booking',
      body: '{{client}} · {{service}} · {{date}} {{time}} with {{staff}}',
    },
  },
  push_booking_cancelled: {
    el: {
      title: 'Ακύρωση ραντεβού',
      body: '{{client}} · {{date}} {{time}} με {{staff}}',
    },
    en: {
      title: 'Appointment cancelled',
      body: '{{client}} · {{date}} {{time}} with {{staff}}',
    },
  },
  /** The appointment after the move: its new time and (after a hand-over) its new staff member. */
  push_booking_moved: {
    el: {
      title: 'Αλλαγή ραντεβού',
      body: '{{client}} · νέα ώρα {{date}} {{time}} με {{staff}}',
    },
    en: {
      title: 'Appointment moved',
      body: '{{client}} · now {{date}} {{time}} with {{staff}}',
    },
  },
  /** Settings → Ειδοποιήσεις «Δοκιμαστική ειδοποίηση» (and `spike-push` until 1.10 deletes it). */
  push_test: {
    el: {
      title: 'Δοκιμαστική ειδοποίηση',
      body: 'Αν το βλέπεις, οι ειδοποιήσεις λειτουργούν σε αυτή τη συσκευή.',
    },
    en: {
      title: 'Test notification',
      body: 'If you can see this, notifications work on this device.',
    },
  },
  /**
   * 1.9: to the owners of the business when a member's authenticator device was added or removed
   * outside the app (`security_events`); opens Ρυθμίσεις → Μέλη. Drafts for Michalis (§7).
   */
  push_security_alert: {
    el: {
      title: 'Ειδοποίηση ασφαλείας',
      body: '{{business}}: μια συσκευή κωδικών άλλαξε χωρίς έγκριση. Δες το email σου.',
    },
    en: {
      title: 'Security alert',
      body: '{{business}}: an authenticator device changed without approval. Check your email.',
    },
  },
} as const satisfies Record<string, Record<PushLocale, PushTemplate>>

export type PushTemplateKey = keyof typeof PUSH_TEMPLATES

export const PUSH_TEMPLATE_KEYS = Object.keys(PUSH_TEMPLATES) as PushTemplateKey[]

export function isPushTemplateKey(value: string): value is PushTemplateKey {
  return Object.hasOwn(PUSH_TEMPLATES, value)
}

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

/**
 * Every language at once, for providers that pick the text on the device (OneSignal). The
 * values are per language: dates and the client fallback differ between el and en.
 */
export function renderPushAllLocales(
  key: PushTemplateKey,
  valuesByLocale: Readonly<Record<PushLocale, Readonly<Record<string, string>>>> = {
    el: {},
    en: {},
  },
): Record<PushLocale, PushTemplate> {
  return {
    el: renderPush(key, 'el', valuesByLocale.el),
    en: renderPush(key, 'en', valuesByLocale.en),
  }
}

/**
 * A value within its limit: trimmed, and when longer cut to `max - 1` characters plus `…`.
 * Counts code points, so an emoji or a combining pair is never split in half.
 */
export function capPushValue(value: string, max: number): string {
  const chars = Array.from(value.trim())
  if (chars.length <= max) return chars.join('')
  return `${chars
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`
}
