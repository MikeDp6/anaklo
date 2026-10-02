import { describe, expect, it } from 'vitest'
import elBooking from './el/booking.json'
import elCommon from './el/common.json'
import elPro from './el/pro.json'
import enBooking from './en/booking.json'
import enCommon from './en/common.json'
import enPro from './en/pro.json'

/**
 * The UI never says «TOTP», «MFA» or «2FA» (plan 1.7 «Εγγραφή», CLAUDE.md «Σύνδεση
 * προσωπικού»): it says «εφαρμογή κωδικών», «κωδικός 6 ψηφίων», «δεύτερη συσκευή». Values only;
 * keys may name the feature (`mfa.*`). Every namespace, both languages.
 */
const CATALOGUES = {
  'el/common': elCommon,
  'el/booking': elBooking,
  'el/pro': elPro,
  'en/common': enCommon,
  'en/booking': enBooking,
  'en/pro': enPro,
} as const

const AUTH_JARGON = /totp|mfa|2fa/i

function leaves(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('no authentication jargon in any text (plan 1.7)', () => {
  it.each(Object.entries(CATALOGUES))('%s: no value says TOTP, MFA or 2FA', (_, catalogue) => {
    const hits = leaves(catalogue).filter(([, text]) => AUTH_JARGON.test(text))
    expect(hits).toEqual([])
  })

  it('every catalogue has texts to check', () => {
    for (const catalogue of Object.values(CATALOGUES)) {
      expect(leaves(catalogue).length).toBeGreaterThan(0)
    }
  })

  it('the check catches every spelling, also inside a sentence', () => {
    expect(AUTH_JARGON.test('Ενεργοποίησε το TOTP')).toBe(true)
    expect(AUTH_JARGON.test('mfa')).toBe(true)
    expect(AUTH_JARGON.test('Turn on 2FA now')).toBe(true)
    expect(AUTH_JARGON.test('Κωδικός από την εφαρμογή κωδικών')).toBe(false)
  })
})
