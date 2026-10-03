import { describe, expect, it } from 'vitest'
import { SECURITY_EMAIL_AUDIENCES, SECURITY_EVENT_KINDS } from './domain.ts'
import {
  renderSecurityEmail,
  SECURITY_EMAIL_KEYS,
  SECURITY_EMAIL_LOCALES,
  SECURITY_EMAIL_SUBJECT_MAX,
  SECURITY_EMAIL_TEMPLATES,
  SECURITY_EMAIL_VARIABLES,
  securityEmailKey,
  securityEmailVariables,
  type SecurityEmailKey,
} from './security-email-templates.ts'

/** businesses.name is 1–80 characters (0001): the longest, Greek, with accents. */
const LONGEST_BUSINESS =
  'Κομμωτήριο & Κουρείο «Η Ωραία Ελένη» — Αγία Παρασκευή, Λεωφόρος Μεσογείων 123'
    .padEnd(80, 'ά')
    .slice(0, 80)

const VALUES = {
  account: 'manager.with.a.long.address@demo-barber.test',
  business: LONGEST_BUSINESS,
  date: '03/10/2026',
  time: '21:07',
  support: 'support@example.com',
} as const

const USER_VARIABLES = ['account', 'date', 'support', 'time']
const OWNER_VARIABLES = ['account', 'business', 'date', 'support', 'time']

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

describe('security email templates (contract 1.9 §3.4)', () => {
  it('are exactly the event kinds × the audiences of domain.ts', () => {
    const expected = SECURITY_EVENT_KINDS.flatMap((kind) =>
      SECURITY_EMAIL_AUDIENCES.map((audience) => securityEmailKey(kind, audience)),
    )
    expect([...SECURITY_EMAIL_KEYS].sort()).toEqual([...expected].sort())
    expect([...SECURITY_EMAIL_KEYS].sort()).toEqual([
      'factor_added_owner',
      'factor_added_user',
      'factor_removed_owner',
      'factor_removed_user',
    ])
  })

  it('have the same templates in el and en (el = en)', () => {
    for (const key of SECURITY_EMAIL_KEYS) {
      expect(Object.keys(SECURITY_EMAIL_TEMPLATES[key]).sort()).toEqual(
        [...SECURITY_EMAIL_LOCALES].sort(),
      )
    }
  })

  it('use the same variables in every language: user = account, date, time, support; owner + business', () => {
    for (const key of SECURITY_EMAIL_KEYS) {
      const el = securityEmailVariables(key, 'el')
      expect(securityEmailVariables(key, 'en'), key).toEqual(el)
      for (const name of el) expect([...SECURITY_EMAIL_VARIABLES]).toContain(name)
      expect(el, key).toEqual(key.endsWith('_owner') ? OWNER_VARIABLES : USER_VARIABLES)
    }
  })

  it('render with the longest values, nothing left, subjects within the limit', () => {
    expect(Array.from(LONGEST_BUSINESS)).toHaveLength(80)
    for (const key of SECURITY_EMAIL_KEYS) {
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

  it('never carry a link, a code, an IP or a factor, and never the words TOTP/MFA/2FA', () => {
    for (const { key, locale, value } of allTexts()) {
      const where = `${key} ${locale}`
      expect(value, where).not.toMatch(/https?:|www\./i)
      expect(value, where).not.toMatch(/\{\{\s*(code|link|url|ip|factor|factor_id|device)\s*\}\}/)
      expect(value, where).not.toMatch(/totp|mfa|2fa/i)
    }
  })

  it('end every email with the same promise: no links, never a code asked', () => {
    for (const key of SECURITY_EMAIL_KEYS) {
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
