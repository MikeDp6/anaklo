/**
 * Phone numbers are stored as E.164 (`+3069…`) and only produced here (CLAUDE.md rule 7).
 * Greek numbers get full validation; other countries are accepted in international form with a
 * length check. The server re-validates. A phone number is NOT a client identity key.
 */

export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: 'empty' | 'invalid' }

const E164 = /^\+[1-9]\d{7,14}$/
// Greek national numbers: 10 digits, landlines start with 2, mobiles with 69.
const GREEK_NATIONAL = /^(2\d{9}|69\d{8})$/

// Numbers copied from contacts apps and messengers carry invisible direction/zero-width marks
// (Unicode "format" characters) and fancy dashes; both are cleaned before validation.
const INVISIBLE_FORMAT_CHARS = /\p{Cf}/gu
const DASHES = /[\p{Pd}−]/gu

export function normalizePhone(input: string): PhoneResult {
  const trimmed = input.replace(INVISIBLE_FORMAT_CHARS, '').replace(DASHES, '-').trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (/[^\d\s+().\-/]/.test(trimmed)) return { ok: false, reason: 'invalid' }

  let digits = trimmed.replace(/[\s().\-/]/g, '')
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`
  if (digits.indexOf('+') > 0) return { ok: false, reason: 'invalid' }

  if (digits.startsWith('+')) {
    if (digits.startsWith('+30')) {
      return GREEK_NATIONAL.test(digits.slice(3))
        ? { ok: true, e164: digits }
        : { ok: false, reason: 'invalid' }
    }
    return E164.test(digits) ? { ok: true, e164: digits } : { ok: false, reason: 'invalid' }
  }

  if (GREEK_NATIONAL.test(digits)) return { ok: true, e164: `+30${digits}` }
  if (digits.startsWith('30') && GREEK_NATIONAL.test(digits.slice(2)))
    return { ok: true, e164: `+${digits}` }

  return { ok: false, reason: 'invalid' }
}

export function isGreekMobile(e164: string): boolean {
  return /^\+3069\d{8}$/.test(e164)
}

/** `+30 694 123 4567`, `+30 210 123 4567`; other countries are shown as stored. */
export function formatPhone(e164: string): string {
  const greek = /^\+30(\d{3})(\d{3})(\d{4})$/.exec(e164)
  if (greek) return `+30 ${greek[1]} ${greek[2]} ${greek[3]}`
  return e164
}
