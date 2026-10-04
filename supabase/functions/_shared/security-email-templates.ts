import type { SecurityEmailAudience, SecurityEventKind } from './domain.ts'

/**
 * The security emails of step 1.9 (ADR-0009 §21, contract 1.9 §3.4): what `dispatch` sends to the
 * affected account and to the owners of its businesses when an authenticator device was added or
 * removed outside the app, and (1.9b, contract 1.9b §3.1) the copy of every event to Nous at
 * `SUPPORT_EMAIL`, so Nous learns of it even when the only owner's mailbox is compromised.
 * A documented exception to CLAUDE.md rule 8, like `sms-templates.ts` (ADR-0007) and
 * `push-templates.ts` (ADR-0010): an Edge Function (Deno) sends them and does not load the web
 * i18n catalogues. el and en have the same keys and variables (the test checks it).
 *
 * Plain text. Never a link, a code, an IP, a factor id or the device's friendly name (text the
 * attacker chose). The owner email names the affected account by its email address (D14); the
 * date and time are the detection, in the business's time zone (the caller formats them). The
 * Nous email is Greek, in UTC, and names the account, its owner/manager businesses (name and
 * slug), how many owner emails the bundle had and the event id (the reference of the runbook
 * `security-event.md`).
 * The texts are drafts for Michalis (contract 1.9 §7.1, contract 1.9b §7.14); the variables are
 * binding.
 */

export type SecurityEmailLocale = 'el' | 'en'

export const SECURITY_EMAIL_LOCALES: readonly SecurityEmailLocale[] = ['el', 'en']

/**
 * Who a security email goes to: the bundle's audiences of `domain.ts` (`user`, `owner`, the values
 * the SQL writes) and `nous`, the copy `dispatch` adds itself (contract 1.9b B1).
 */
export type SecurityEmailRecipient = SecurityEmailAudience | 'nous'
export const SECURITY_EMAIL_RECIPIENTS = [
  'user',
  'owner',
  'nous',
] as const satisfies readonly SecurityEmailRecipient[]

/** The Nous copy: always Greek, date and time in UTC (never a business's zone, rule 6). */
export const SECURITY_NOUS_LOCALE: SecurityEmailLocale = 'el'
export const SECURITY_NOUS_TIME_ZONE = 'UTC'

export type SecurityEmailTemplate = { readonly subject: string; readonly text: string }

/** What the account must do, the same closing line in every user and owner email. */
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

/** The Nous copy (1.9b): where the account has rights, and what Nous does next. */
const NOUS_BUSINESSES = {
  el: 'Επιχειρήσεις όπου ο λογαριασμός είναι ιδιοκτήτης ή διαχειριστής: {{businesses}}.',
  en: 'Businesses where the account is an owner or a manager: {{businesses}}.',
} as const

const NOUS_NEXT = {
  el:
    'Τι κάνεις: runbook security-event.md, αναφορά {{event}}. Επικοινωνία μόνο από κανάλι που ' +
    'ήδη γνωρίζουμε (το τηλέφωνο του καταστήματος από τα στοιχεία μας), ποτέ με στοιχεία από ' +
    'εισερχόμενο μήνυμα.',
  en:
    'Next: runbook security-event.md, reference {{event}}. Contact only through a channel we ' +
    'already know (the shop phone on file), never with details from an incoming message.',
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
  factor_added_nous: {
    el: {
      subject: 'Anaklo · Nous: προστέθηκε συσκευή κωδικών χωρίς έγκριση',
      text: paragraphs(
        'Στις {{date}} {{time}} UTC ο έλεγχος βρήκε μια συσκευή κωδικών που προστέθηκε χωρίς ' +
          'έγκριση στον λογαριασμό {{account}}.',
        NOUS_BUSINESSES.el,
        'Τι έγινε αυτόματα: η συσκευή αφαιρέθηκε, ο λογαριασμός αποσυνδέθηκε από όλες τις ' +
          'συσκευές και στάλθηκε email στον λογαριασμό και σε {{owners}} ιδιοκτήτες.',
        NOUS_NEXT.el,
      ),
    },
    en: {
      subject: 'Anaklo · Nous: authenticator device added without approval',
      text: paragraphs(
        'On {{date}} at {{time}} UTC the check found an authenticator device added without ' +
          'approval to the account {{account}}.',
        NOUS_BUSINESSES.en,
        'What was done automatically: the device was removed, the account was signed out of every device ' +
          'and an email went to the account and to {{owners}} owners.',
        NOUS_NEXT.en,
      ),
    },
  },
  factor_removed_nous: {
    el: {
      subject: 'Anaklo · Nous: αφαιρέθηκε συσκευή κωδικών χωρίς έγκριση',
      text: paragraphs(
        'Στις {{date}} {{time}} UTC ο έλεγχος βρήκε ότι αφαιρέθηκε χωρίς έγκριση μια συσκευή ' +
          'κωδικών από τον λογαριασμό {{account}}.',
        NOUS_BUSINESSES.el,
        'Τι έγινε αυτόματα: ο λογαριασμός αποσυνδέθηκε από όλες τις συσκευές και στάλθηκε email ' +
          'στον λογαριασμό και σε {{owners}} ιδιοκτήτες. Αν δεν του έμεινε εγκεκριμένη συσκευή, ' +
          'η προσθήκη νέας είναι κλειστή μέχρι την επαναφορά από τη Nous, και η εφαρμογή τού ' +
          'δείχνει «Επικοινώνησε με τη Nous».',
        NOUS_NEXT.el,
      ),
    },
    en: {
      subject: 'Anaklo · Nous: authenticator device removed without approval',
      text: paragraphs(
        'On {{date}} at {{time}} UTC the check found that an authenticator device was removed ' +
          'without approval from the account {{account}}.',
        NOUS_BUSINESSES.en,
        'What was done automatically: the account was signed out of every device and an email went to ' +
          'the account and to {{owners}} owners. If no approved device is left, adding a new one ' +
          'is closed until Nous resets it, and the app shows them "Contact Nous".',
        NOUS_NEXT.en,
      ),
    },
  },
} as const satisfies Record<string, Record<SecurityEmailLocale, SecurityEmailTemplate>>

export type SecurityEmailKey = keyof typeof SECURITY_EMAIL_TEMPLATES

export const SECURITY_EMAIL_KEYS = Object.keys(SECURITY_EMAIL_TEMPLATES) as SecurityEmailKey[]

/** Mail clients cut longer subjects; the test renders with the longest business name (80). */
export const SECURITY_EMAIL_SUBJECT_MAX = 150

/**
 * Every variable a security email may use (contract 1.9 §3.4, 1.9b §3.1); which ones each
 * recipient's emails use is `SECURITY_EMAIL_RECIPIENT_VARIABLES`.
 */
export const SECURITY_EMAIL_VARIABLES = [
  'account',
  'business',
  'businesses',
  'date',
  'event',
  'owners',
  'support',
  'time',
] as const
export type SecurityEmailVariable = (typeof SECURITY_EMAIL_VARIABLES)[number]

/**
 * Exactly the variables of each recipient's emails, in el and en (binding, the test checks it):
 * the owner email adds the business; the Nous copy has no `support` (it goes to that address)
 * but the businesses, the event id and the number of owner emails.
 */
export const SECURITY_EMAIL_RECIPIENT_VARIABLES = {
  user: ['account', 'date', 'support', 'time'],
  owner: ['account', 'business', 'date', 'support', 'time'],
  nous: ['account', 'businesses', 'date', 'event', 'owners', 'time'],
} as const satisfies Record<SecurityEmailRecipient, readonly SecurityEmailVariable[]>

export type SecurityEmailValues = Partial<Record<SecurityEmailVariable, string>>

/** The template of an event kind for a recipient (`factor_added_unauthorized` + `user` → …). */
export function securityEmailKey(
  kind: SecurityEventKind,
  recipient: SecurityEmailRecipient,
): SecurityEmailKey {
  const change = kind === 'factor_added_unauthorized' ? 'factor_added' : 'factor_removed'
  return `${change}_${recipient}`
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
