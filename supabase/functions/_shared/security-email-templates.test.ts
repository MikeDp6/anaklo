import { describe, expect, it } from 'vitest'
import { SECURITY_EMAIL_AUDIENCES, SECURITY_EVENT_KINDS } from './domain.ts'
import {
  renderSecurityEmail,
  SECURITY_EMAIL_KEYS,
  SECURITY_EMAIL_LOCALES,
  SECURITY_EMAIL_RECIPIENT_VARIABLES,
  SECURITY_EMAIL_RECIPIENTS,
  SECURITY_EMAIL_SUBJECT_MAX,
  SECURITY_EMAIL_TEMPLATES,
  SECURITY_EMAIL_VARIABLES,
  SECURITY_NOUS_LOCALE,
  SECURITY_NOUS_TIME_ZONE,
  securityEmailKey,
  securityEmailVariables,
  type SecurityEmailKey,
  type SecurityEmailRecipient,
} from './security-email-templates.ts'

/** businesses.name is 1–80 characters (0001): the longest, Greek, with accents. */
const LONGEST_BUSINESS =
  'Κομμωτήριο & Κουρείο «Η Ωραία Ελένη» — Αγία Παρασκευή, Λεωφόρος Μεσογείων 123'
    .padEnd(80, 'ά')
    .slice(0, 80)

/** businesses.slug is at most 40 characters (0001). */
const LONGEST_SLUG = 'a'.repeat(40)
/** auth.users.email: the longest address (254), the Nous copy's `account`. */
const LONGEST_ACCOUNT = `${'m'.repeat(254 - '@demo-barber.test'.length)}@demo-barber.test`
/** Three businesses as dispatch writes them: `<name> (<slug>)` joined by `, `. */
const THREE_BUSINESSES = Array.from(
  { length: 3 },
  () => `${LONGEST_BUSINESS} (${LONGEST_SLUG})`,
).join(', ')
const EVENT = '9b2f6c1e-0d4a-4e8b-b7c3-5a6d7e8f9a0b'

const VALUES = {
  account: 'manager.with.a.long.address@demo-barber.test',
  business: LONGEST_BUSINESS,
  date: '03/10/2026',
  time: '21:07',
  support: 'support@example.com',
} as const

const NOUS_VALUES = {
  account: LONGEST_ACCOUNT,
  businesses: THREE_BUSINESSES,
  date: '03/10/2026',
  time: '18:07',
  event: EVENT,
  owners: '3',
} as const

const USER_VARIABLES = ['account', 'date', 'support', 'time']
const OWNER_VARIABLES = ['account', 'business', 'date', 'support', 'time']
const NOUS_VARIABLES = ['account', 'businesses', 'date', 'event', 'owners', 'time']

/** The recipient of a key (its last segment). */
function recipientOf(key: SecurityEmailKey): SecurityEmailRecipient {
  const recipient = SECURITY_EMAIL_RECIPIENTS.find((value) => key.endsWith(`_${value}`))
  if (recipient === undefined) throw new Error(`no recipient in ${key}`)
  return recipient
}

const NOUS_KEYS = SECURITY_EMAIL_KEYS.filter((key) => recipientOf(key) === 'nous')
const MEMBER_KEYS = SECURITY_EMAIL_KEYS.filter((key) => recipientOf(key) !== 'nous')

function allTexts(): Array<{ key: SecurityEmailKey; locale: string; value: string }> {
  return SECURITY_EMAIL_KEYS.flatMap((key) =>
    SECURITY_EMAIL_LOCALES.flatMap((locale) => {
      const { subject, text } = SECURITY_EMAIL_TEMPLATES[key][locale]
      return [
        { key, locale, value: subject },
        { key, locale, value: text },
      ]
    }),
  )
}

describe('security email templates (contract 1.9 §3.4, 1.9b §3.1)', () => {
  it('are exactly the event kinds × the recipients (the audiences of domain.ts and nous)', () => {
    const expected = SECURITY_EVENT_KINDS.flatMap((kind) =>
      SECURITY_EMAIL_RECIPIENTS.map((recipient) => securityEmailKey(kind, recipient)),
    )
    expect([...SECURITY_EMAIL_KEYS].sort()).toEqual([...expected].sort())
    expect([...SECURITY_EMAIL_KEYS].sort()).toEqual([
      'factor_added_nous',
      'factor_added_owner',
      'factor_added_user',
      'factor_removed_nous',
      'factor_removed_owner',
      'factor_removed_user',
    ])
    // The SQL bundle's audiences stay user and owner; nous is the copy dispatch adds.
    expect([...SECURITY_EMAIL_AUDIENCES]).toEqual(['user', 'owner'])
    expect([...SECURITY_EMAIL_RECIPIENTS]).toEqual([...SECURITY_EMAIL_AUDIENCES, 'nous'])
  })

  it('have the same templates in el and en (el = en)', () => {
    for (const key of SECURITY_EMAIL_KEYS) {
      expect(Object.keys(SECURITY_EMAIL_TEMPLATES[key]).sort()).toEqual(
        [...SECURITY_EMAIL_LOCALES].sort(),
      )
    }
  })

  it('use the same variables in every language: exactly the recipient’s set', () => {
    expect(SECURITY_EMAIL_RECIPIENT_VARIABLES).toEqual({
      user: USER_VARIABLES,
      owner: OWNER_VARIABLES,
      nous: NOUS_VARIABLES,
    })
    for (const key of SECURITY_EMAIL_KEYS) {
      const el = securityEmailVariables(key, 'el')
      expect(securityEmailVariables(key, 'en'), key).toEqual(el)
      for (const name of el) expect([...SECURITY_EMAIL_VARIABLES]).toContain(name)
      expect(el, key).toEqual([...SECURITY_EMAIL_RECIPIENT_VARIABLES[recipientOf(key)]])
    }
    // Every declared variable is used by some template.
    const used = new Set(SECURITY_EMAIL_KEYS.flatMap((key) => securityEmailVariables(key, 'el')))
    expect([...used].sort()).toEqual([...SECURITY_EMAIL_VARIABLES].sort())
  })

  it('render with the longest values, nothing left, subjects within the limit', () => {
    expect(Array.from(LONGEST_BUSINESS)).toHaveLength(80)
    for (const key of MEMBER_KEYS) {
      for (const locale of SECURITY_EMAIL_LOCALES) {
        const { subject, text } = renderSecurityEmail(key, locale, VALUES)
        expect(`${subject}\n${text}`, `${key} ${locale}`).not.toMatch(/\{\{|\}\}/)
        expect(subject.length, `${key} ${locale} subject`).toBeLessThanOrEqual(
          SECURITY_EMAIL_SUBJECT_MAX,
        )
        expect(subject).not.toMatch(/[\r\n]/)
        expect(text).toContain(VALUES.account)
        expect(text).toContain(VALUES.support)
        expect(text).toContain(`${VALUES.date}`)
        expect(text).toContain(VALUES.time)
        if (key.endsWith('_owner')) {
          expect(subject).toContain(LONGEST_BUSINESS)
          expect(text).toContain(LONGEST_BUSINESS)
        }
      }
    }
  })

  it('render the Nous copy with the longest values (account 254, three businesses), nothing left', () => {
    expect(LONGEST_ACCOUNT).toHaveLength(254)
    expect(NOUS_KEYS).toHaveLength(2)
    for (const key of NOUS_KEYS) {
      for (const locale of SECURITY_EMAIL_LOCALES) {
        const { subject, text } = renderSecurityEmail(key, locale, NOUS_VALUES)
        const where = `${key} ${locale}`
        expect(`${subject}\n${text}`, where).not.toMatch(/\{\{|\}\}/)
        expect(subject.length, `${where} subject`).toBeLessThanOrEqual(SECURITY_EMAIL_SUBJECT_MAX)
        expect(subject).not.toMatch(/[\r\n]/)
        expect(subject).toMatch(/^Anaklo · Nous: /)
        expect(text, where).toContain(LONGEST_ACCOUNT)
        expect(text, where).toContain(THREE_BUSINESSES)
        expect(text, where).toContain(EVENT)
        expect(text, where).toContain(`${NOUS_VALUES.date}`)
        expect(text, where).toContain(`${NOUS_VALUES.time} UTC`)
        expect(text, where).toContain('runbook security-event.md')
        // It goes to SUPPORT_EMAIL: it never names an address of its own.
        expect(text, where).not.toContain(VALUES.support)
      }
    }
  })

  it('the Nous copy is Greek, in UTC, and says what was done and what Nous does next', () => {
    expect(SECURITY_NOUS_LOCALE).toBe('el')
    expect(SECURITY_NOUS_TIME_ZONE).toBe('UTC')
    const added = renderSecurityEmail('factor_added_nous', 'el', NOUS_VALUES)
    expect(added.subject).toBe('Anaklo · Nous: προστέθηκε συσκευή κωδικών χωρίς έγκριση')
    expect(added.text).toContain(
      `Στις 03/10/2026 18:07 UTC ο έλεγχος βρήκε μια συσκευή κωδικών που προστέθηκε χωρίς έγκριση στον λογαριασμό ${LONGEST_ACCOUNT}.`,
    )
    expect(added.text).toContain(
      `Επιχειρήσεις όπου ο λογαριασμός είναι ιδιοκτήτης ή διαχειριστής: ${THREE_BUSINESSES}.`,
    )
    expect(added.text).toContain('η συσκευή αφαιρέθηκε')
    expect(added.text).toContain('σε 3 ιδιοκτήτες')
    expect(added.text).toContain(`runbook security-event.md, αναφορά ${EVENT}.`)
    expect(added.text).not.toContain('Επικοινώνησε με τη Nous')

    const removed = renderSecurityEmail('factor_removed_nous', 'el', NOUS_VALUES)
    expect(removed.subject).toBe('Anaklo · Nous: αφαιρέθηκε συσκευή κωδικών χωρίς έγκριση')
    expect(removed.text).toContain('«Επικοινώνησε με τη Nous»')
    expect(removed.text).toContain('η προσθήκη νέας είναι κλειστή μέχρι την επαναφορά από τη Nous')
    expect(removed.text).not.toContain('η συσκευή αφαιρέθηκε')

    const removedEn = renderSecurityEmail('factor_removed_nous', 'en', NOUS_VALUES)
    expect(removedEn.subject).toBe('Anaklo · Nous: authenticator device removed without approval')
    expect(removedEn.text).toContain('On 03/10/2026 at 18:07 UTC the check found')
    expect(removedEn.text).toContain('"Contact Nous"')
    for (const key of NOUS_KEYS) {
      expect(
        SECURITY_EMAIL_TEMPLATES[key].el.text.endsWith('ποτέ με στοιχεία από εισερχόμενο μήνυμα.'),
      ).toBe(true)
      expect(
        SECURITY_EMAIL_TEMPLATES[key].en.text.endsWith(
          'never with details from an incoming message.',
        ),
      ).toBe(true)
    }
  })

  it('never carry a link, a code, an IP or a factor, and never the words TOTP/MFA/2FA', () => {
    for (const { key, locale, value } of allTexts()) {
      const where = `${key} ${locale}`
      expect(value, where).not.toMatch(/https?:|www\./i)
      expect(value, where).not.toMatch(/\{\{\s*(code|link|url|ip|factor|factor_id|device)\s*\}\}/)
      expect(value, where).not.toMatch(/totp|mfa|2fa/i)
    }
  })

  it('end every member email with the same promise: no links, never a code asked', () => {
    expect(MEMBER_KEYS).toHaveLength(4)
    for (const key of MEMBER_KEYS) {
      expect(
        SECURITY_EMAIL_TEMPLATES[key].el.text.endsWith(
          'Τα μηνύματα ασφαλείας του Anaklo δεν έχουν ποτέ links και δεν σου ζητούν ποτέ κωδικούς.',
        ),
      ).toBe(true)
      expect(
        SECURITY_EMAIL_TEMPLATES[key].en.text.endsWith(
          'Anaklo security messages never contain links and never ask you for a code.',
        ),
      ).toBe(true)
    }
  })

  it('say what happened and what was done for each kind', () => {
    const added = renderSecurityEmail('factor_added_user', 'el', VALUES)
    expect(added.subject).toBe(
      'Anaklo: αφαιρέσαμε μια συσκευή κωδικών που προστέθηκε χωρίς έγκριση',
    )
    expect(added.text).toContain('Στις 03/10/2026 21:07 προστέθηκε μια νέα συσκευή κωδικών')
    expect(added.text).toContain('αφαιρέσαμε αυτή τη συσκευή')
    const removed = renderSecurityEmail('factor_removed_owner', 'en', VALUES)
    expect(removed.text).toContain(
      `On 03/10/2026 at 21:07 an authenticator device was removed from the account ${VALUES.account} of ${LONGEST_BUSINESS}`,
    )
    expect(removed.text).toContain('cannot be restored')
    expect(removed.text).toContain('Settings → Members')
    expect(removed.text).not.toContain('We removed the device')
  })

  it('fails loudly when a variable is missing or empty', () => {
    expect(() =>
      renderSecurityEmail('factor_added_owner', 'el', { ...VALUES, business: undefined }),
    ).toThrow(/needs \{\{business\}\}/)
    expect(() =>
      renderSecurityEmail('factor_added_user', 'en', { ...VALUES, account: ' ' }),
    ).toThrow(/needs \{\{account\}\}/)
    // The user emails do not need the business.
    const userValues = {
      account: VALUES.account,
      date: VALUES.date,
      time: VALUES.time,
      support: VALUES.support,
    }
    expect(() => renderSecurityEmail('factor_removed_user', 'el', userValues)).not.toThrow()
    // The Nous copy needs its own variables, never `support`.
    expect(() =>
      renderSecurityEmail('factor_added_nous', 'el', { ...NOUS_VALUES, event: undefined }),
    ).toThrow(/needs \{\{event\}\}/)
    expect(() =>
      renderSecurityEmail('factor_removed_nous', 'en', { ...NOUS_VALUES, businesses: '' }),
    ).toThrow(/needs \{\{businesses\}\}/)
    expect(() => renderSecurityEmail('factor_removed_nous', 'el', NOUS_VALUES)).not.toThrow()
  })

  it('keeps every value on one line (no header or paragraph of its own)', () => {
    const { subject, text } = renderSecurityEmail('factor_added_owner', 'en', {
      ...VALUES,
      business: 'Demo\r\nBcc: x@y.test\nBarber',
    })
    expect(subject).toBe(
      "Anaklo · Demo Bcc: x@y.test Barber: unapproved authenticator device on a member's account",
    )
    expect(text).not.toContain('\nBcc')
  })
})
