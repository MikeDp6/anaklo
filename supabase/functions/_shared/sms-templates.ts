import { clipForSms, prepareSms, type PreparedSms, type SmsVariable } from './sms.ts'

/**
 * SMS texts, written normally (lower case, accents) and converted by `prepareSms`.
 * They live here, not in the web i18n files, because Edge Functions (Deno) render and send them.
 * Every template must fit ONE GSM-7 SMS with every variable at its maximum length (sms.test.ts).
 * Links, codes and domains contain no Greek, so the conversion leaves them byte-for-byte intact.
 */
export type SmsLocale = 'el' | 'en'

export const SMS_TEMPLATES = {
  otp: {
    el: '{{code}} είναι ο κωδικός σου για {{business}}. Λήγει σε 5 λεπτά.\n\n@{{domain}} #{{code}}',
    en: '{{code}} is your code for {{business}}. It expires in 5 minutes.\n\n@{{domain}} #{{code}}',
  },
  booking_confirmed: {
    el: '{{business}}: κλείστηκε ραντεβού {{date}} {{time}} με {{staff}}. Αλλαγή/ακύρωση: {{link}} (μην απαντάς εδώ)',
    en: '{{business}}: booked for {{date}} {{time}} with {{staff}}. Change/cancel: {{link}} (replies are not read)',
  },
  reminder: {
    el: '{{business}}: υπενθύμιση για {{date}} {{time}} με {{staff}}. Αλλαγή/ακύρωση: {{link}} (μην απαντάς εδώ)',
    en: '{{business}}: reminder for {{date}} {{time}} with {{staff}}. Change/cancel: {{link}} (replies are not read)',
  },
  cancelled_by_client: {
    el: '{{business}}: ακύρωσες το ραντεβού {{date}} {{time}}. Κλείσε νέο: {{link}}',
    en: '{{business}}: you cancelled {{date}} {{time}}. Book again: {{link}}',
  },
  cancelled_by_business: {
    el: '{{business}}: το ραντεβού σου {{date}} {{time}} ακυρώθηκε, ζητούμε συγγνώμη. Κλείσε νέο: {{link}}',
    en: '{{business}}: your appointment {{date}} {{time}} was cancelled, sorry. Book again: {{link}}',
  },
  // The client moved the booking through the manage link (1.3): the new time and a NEW link.
  rescheduled_by_client: {
    el: '{{business}}: νέα ώρα ραντεβού {{date}} {{time}} με {{staff}}. Αλλαγή/ακύρωση: {{link}} (μην απαντάς εδώ)',
    en: '{{business}}: moved to {{date}} {{time}} with {{staff}}. Change/cancel: {{link}} (replies are not read)',
  },
} as const satisfies Record<string, Record<SmsLocale, string>>

export type SmsTemplateKey = keyof typeof SMS_TEMPLATES

const PLACEHOLDER = /\{\{(\w+)\}\}/g

export function templateVariables(key: SmsTemplateKey, locale: SmsLocale): SmsVariable[] {
  const found = new Set<SmsVariable>()
  for (const match of SMS_TEMPLATES[key][locale].matchAll(PLACEHOLDER)) {
    found.add(match[1] as SmsVariable)
  }
  return [...found]
}

export function renderSms(
  key: SmsTemplateKey,
  locale: SmsLocale,
  values: Partial<Record<SmsVariable, string>>,
): PreparedSms {
  const text = SMS_TEMPLATES[key][locale].replace(PLACEHOLDER, (_whole, name: string) => {
    const variable = name as SmsVariable
    const value = values[variable]
    if (value === undefined) throw new Error(`SMS template ${key} needs {{${name}}}`)
    return clipForSms(variable, value)
  })
  const sms = prepareSms(text)
  // Guaranteed by the limits and sms.test.ts; checked again so a mistake never costs 2+ SMS.
  if (sms.encoding !== 'GSM-7' || sms.segments !== 1) {
    throw new Error(
      `SMS template ${key} (${locale}) does not fit one GSM-7 SMS (${sms.units} septets)`,
    )
  }
  return sms
}
