import type { SecurityEmailAudience, SecurityEventKind } from './domain.ts'

/**
 * The security emails of step 1.9 (ADR-0009 §21, contract 1.9 §3.4): what `dispatch` sends to the
 * affected account and to the owners of its businesses when an authenticator device was added or
 * removed outside the app. A documented exception to CLAUDE.md rule 8, like `sms-templates.ts`
 * (ADR-0007) and `push-templates.ts` (ADR-0010): an Edge Function (Deno) sends them and does not
 * load the web i18n catalogues. el and en have the same keys and variables (the test checks it).
 *
 * Plain text. Never a link, a code, an IP, a factor id or the device's friendly name (text the
 * attacker chose). The owner email names the affected account by its email address (D14); the
 * date and time are the detection, in the business's time zone (the caller formats them).
 * The texts are drafts for Michalis (contract 1.9 §7.1); the variables are binding.
 */

export type SecurityEmailLocale = 'el' | 'en'

export const SECURITY_EMAIL_LOCALES: readonly SecurityEmailLocale[] = ['el', 'en']

export type SecurityEmailTemplate = { readonly subject: string; readonly text: string }

/** What the account must do, the same closing line in every email. */
const CLOSING = {
  el: 'Τα μηνύματα ασφαλείας του Anaklo δεν έχουν ποτέ links και δεν σου ζητούν ποτέ κωδικούς.',
  en: 'Anaklo security messages never contain links and never ask you for a code.',
} as const

const OWNER_ACTIONS = {
  el:
    'Αν δεν ξέρεις τι έγινε, μίλησε με το μέλος σε τηλέφωνο που ήδη γνωρίζεις και γράψε μας στο ' +
    '{{support}}. Από τις Ρυθμίσεις → Μέλη μπορείς να αλλάξεις τον ρόλο του ή να το αφαιρέσεις.',
  en:
    'If you do not know what happened, talk to the member on a phone number you already know ' +
    'and write to us at {{support}}. In Settings → Members you can change their role or remove ' +
    'them.',
} as const

function paragraphs(...parts: readonly string[]): string {
  return parts.join('\n\n')
}

export const SECURITY_EMAIL_TEMPLATES = {
  factor_added_user: {
    el: {
      subject: 'Anaklo: αφαιρέσαμε μια συσκευή κωδικών που προστέθηκε χωρίς έγκριση',
      text: paragraphs(
        'Στις {{date}} {{time}} προστέθηκε μια νέα συσκευή κωδικών στον λογαριασμό {{account}}, ' +
          'χωρίς να περάσει από την εφαρμογή Anaklo.',
        'Για την ασφάλειά σου αφαιρέσαμε αυτή τη συσκευή και αποσυνδέσαμε τον λογαριασμό από ' +
          'όλες τις συσκευές.',
        'Τι κάνεις τώρα:\n' +
          '1. Άνοιξε την εφαρμογή από την αρχική οθόνη του κινητού σου και συνδέσου ξανά, με τον ' +
          'κωδικό email και τον κωδικό από τη δική σου εφαρμογή κωδικών.\n' +
          '2. Αν δεν πρόσθεσες εσύ συσκευή, άλλαξε τον κωδικό του email σου και γράψε μας στο ' +
          '{{support}}.',
        CLOSING.el,
      ),
    },
    en: {
      subject: 'Anaklo: we removed an authenticator device added without approval',
      text: paragraphs(
        'On {{date}} at {{time}} a new authenticator device was added to the account ' +
          '{{account}} without going through the Anaklo app.',
        'For your security we removed this device and signed the account out of every device.',
        'What to do now:\n' +
          "1. Open the app from your phone's home screen and sign in again, with the email code " +
          'and the code from your own authenticator app.\n' +
          '2. If you did not add a device yourself, change the password of your email account and ' +
          'write to us at {{support}}.',
        CLOSING.en,
      ),
    },
  },
  factor_removed_user: {
    el: {
      subject: 'Anaklo: αφαιρέθηκε μια συσκευή κωδικών χωρίς έγκριση',
      text: paragraphs(
        'Στις {{date}} {{time}} αφαιρέθηκε μια συσκευή κωδικών από τον λογαριασμό {{account}}, ' +
          'χωρίς να περάσει από την εφαρμογή Anaklo.',
        'Για την ασφάλειά σου αποσυνδέσαμε τον λογαριασμό από όλες τις συσκευές. Η συσκευή που ' +
          'αφαιρέθηκε δεν μπορεί να επανέλθει.',
        'Τι κάνεις τώρα:\n' +
          '1. Συνδέσου ξανά από την εφαρμογή. Αν δεν σου έμεινε άλλη συσκευή κωδικών, η εφαρμογή ' +
          'θα σου ζητήσει να ορίσεις νέα.\n' +
          '2. Αν δεν την αφαίρεσες εσύ, άλλαξε τον κωδικό του email σου και γράψε μας στο ' +
          '{{support}}.',
        CLOSING.el,
      ),
    },
    en: {
      subject: 'Anaklo: an authenticator device was removed without approval',
      text: paragraphs(
        'On {{date}} at {{time}} an authenticator device was removed from the account ' +
          '{{account}} without going through the Anaklo app.',
        'For your security we signed the account out of every device. The removed device cannot ' +
          'be restored.',
        'What to do now:\n' +
          '1. Sign in again from the app. If you have no other authenticator device left, the app ' +
          'will ask you to set up a new one.\n' +
          '2. If you did not remove it yourself, change the password of your email account and ' +
          'write to us at {{support}}.',
        CLOSING.en,
      ),
    },
  },
  factor_added_owner: {
    el: {
      subject: 'Anaklo · {{business}}: συσκευή κωδικών χωρίς έγκριση σε λογαριασμό μέλους',
      text: paragraphs(
        'Στις {{date}} {{time}} προστέθηκε μια νέα συσκευή κωδικών στον λογαριασμό {{account}} ' +
          'του {{business}}, χωρίς να περάσει από την εφαρμογή Anaklo.',
        'Αφαιρέσαμε τη συσκευή και αποσυνδέσαμε αυτόν τον λογαριασμό από όλες τις συσκευές. ' +
          'Ενημερώσαμε και τον ίδιο με email.',
        OWNER_ACTIONS.el,
        CLOSING.el,
      ),
    },
    en: {
      subject: "Anaklo · {{business}}: unapproved authenticator device on a member's account",
      text: paragraphs(
        'On {{date}} at {{time}} a new authenticator device was added to the account ' +
          '{{account}} of {{business}} without going through the Anaklo app.',
        'We removed the device and signed this account out of every device. We have also ' +
          'informed the member by email.',
        OWNER_ACTIONS.en,
        CLOSING.en,
      ),
    },
  },
  factor_removed_owner: {
    el: {
      subject: 'Anaklo · {{business}}: αφαιρέθηκε συσκευή κωδικών μέλους χωρίς έγκριση',
      text: paragraphs(
        'Στις {{date}} {{time}} αφαιρέθηκε μια συσκευή κωδικών από τον λογαριασμό {{account}} ' +
          'του {{business}}, χωρίς να περάσει από την εφαρμογή Anaklo.',
        'Αποσυνδέσαμε αυτόν τον λογαριασμό από όλες τις συσκευές. Η συσκευή δεν μπορεί να ' +
          'επανέλθει. Ενημερώσαμε και τον ίδιο με email.',
        OWNER_ACTIONS.el,
        CLOSING.el,
      ),
    },
    en: {
      // "was" dropped from the draft of §3.4: with an 80-character business name the subject
      // stays within SECURITY_EMAIL_SUBJECT_MAX.
      subject: "Anaklo · {{business}}: a member's authenticator device removed without approval",
      text: paragraphs(
        'On {{date}} at {{time}} an authenticator device was removed from the account ' +
          '{{account}} of {{business}} without going through the Anaklo app.',
        'We signed this account out of every device. The device cannot be restored. We have ' +
          'also informed the member by email.',
        OWNER_ACTIONS.en,
        CLOSING.en,
      ),
    },
  },
} as const satisfies Record<string, Record<SecurityEmailLocale, SecurityEmailTemplate>>

export type SecurityEmailKey = keyof typeof SECURITY_EMAIL_TEMPLATES

export const SECURITY_EMAIL_KEYS = Object.keys(SECURITY_EMAIL_TEMPLATES) as SecurityEmailKey[]

/** Mail clients cut longer subjects; the test renders with the longest business name (80). */
export const SECURITY_EMAIL_SUBJECT_MAX = 150

/** Every variable a security email may use (§3.4); `business` only in the owner emails. */
export const SECURITY_EMAIL_VARIABLES = ['account', 'business', 'date', 'support', 'time'] as const
export type SecurityEmailVariable = (typeof SECURITY_EMAIL_VARIABLES)[number]

export type SecurityEmailValues = Partial<Record<SecurityEmailVariable, string>>

/** The template of an event kind for an audience (`factor_added_unauthorized` + `user` → …). */
export function securityEmailKey(
  kind: SecurityEventKind,
  audience: SecurityEmailAudience,
): SecurityEmailKey {
  const change = kind === 'factor_added_unauthorized' ? 'factor_added' : 'factor_removed'
  return `${change}_${audience}`
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g

export function securityEmailVariables(
  key: SecurityEmailKey,
  locale: SecurityEmailLocale,
): string[] {
  const { subject, text } = SECURITY_EMAIL_TEMPLATES[key][locale]
  const found = new Set<string>()
  for (const match of `${subject}\n${text}`.matchAll(PLACEHOLDER)) {
    if (match[1] !== undefined) found.add(match[1])
  }
  return [...found].sort()
}

/** One line: a value never adds a line or a header of its own. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t\u2028\u2029]+/gu, ' ').trim()
}

function fill(text: string, key: SecurityEmailKey, values: SecurityEmailValues): string {
  return text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = (values as Readonly<Record<string, string | undefined>>)[name]
    if (value === undefined || value.trim() === '') {
      throw new Error(`Security email ${key} needs {{${name}}}`)
    }
    return oneLine(value)
  })
}

/** The subject and text of one email; throws when the template needs a value that is missing. */
export function renderSecurityEmail(
  key: SecurityEmailKey,
  locale: SecurityEmailLocale,
  values: SecurityEmailValues,
): SecurityEmailTemplate {
  const template = SECURITY_EMAIL_TEMPLATES[key][locale]
  return { subject: fill(template.subject, key, values), text: fill(template.text, key, values) }
}
