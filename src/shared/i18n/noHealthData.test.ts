import { describe, expect, it } from 'vitest'
import elBooking from './el/booking.json'
import elCommon from './el/common.json'
import elPro from './el/pro.json'
import enBooking from './en/booking.json'
import enCommon from './en/common.json'
import enPro from './en/pro.json'

/**
 * GDPR art. 9 (contract 1.6 §4.12, plan 1.6): no text of the apps names an illness or health, so
 * no screen ever invites the owner to record why someone is absent. Time off has a closed, neutral
 * list of reasons (`time_off_reason`), and an urgent absence is always `leave`.
 */
const CATALOGUES = {
  'el/common': elCommon,
  'el/booking': elBooking,
  'el/pro': elPro,
  'en/common': enCommon,
  'en/booking': enBooking,
  'en/pro': enPro,
} as const

const HEALTH_TEXT =
  /ασθεν|αρρωστ|υγει|γιατρ|ιατρ|νοσοκ|\bsick|\bill\b|illness|health|doctor|medical|hospital/i
/** Substrings no key may contain; `ill` only as a word of a camelCase/snake_case key. */
const HEALTH_KEY = /sick|health|medical/i
const HEALTH_KEY_WORDS: ReadonlySet<string> = new Set(['ill', 'illness'])

/** Lower case without accents (ά → α, ϊ → ι), so «Υγεία» and «υγεια» match alike. */
function plain(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function leaves(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  )
}

function keyWords(key: string): string[] {
  return key
    .split(/[._]/)
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .map((word) => word.toLowerCase())
}

describe('no health data in any text (GDPR art. 9)', () => {
  it.each(Object.entries(CATALOGUES))(
    '%s: no value mentions an illness or health',
    (_, catalogue) => {
      const hits = leaves(catalogue).filter(([, text]) => HEALTH_TEXT.test(plain(text)))
      expect(hits).toEqual([])
    },
  )

  it.each(Object.entries(CATALOGUES))(
    '%s: no key mentions an illness or health',
    (_, catalogue) => {
      const hits = leaves(catalogue)
        .map(([key]) => key)
        .filter((key) => HEALTH_KEY.test(key) || keyWords(key).some((w) => HEALTH_KEY_WORDS.has(w)))
      expect(hits).toEqual([])
    },
  )

  it('the check itself catches accented, upper-case and English wording', () => {
    expect(HEALTH_TEXT.test(plain('Άδεια ασθενείας'))).toBe(true)
    expect(HEALTH_TEXT.test(plain('ΛΟΓΟΙ ΥΓΕΙΑΣ'))).toBe(true)
    expect(HEALTH_TEXT.test(plain('Ραντεβού στον γιατρό'))).toBe(true)
    expect(HEALTH_TEXT.test(plain('Off sick'))).toBe(true)
    expect(HEALTH_TEXT.test(plain('He is ill'))).toBe(true)
    expect(HEALTH_TEXT.test(plain('We will call'))).toBe(false)
    expect(keyWords('timeOff.reasons.sickLeave')).toContain('sick')
    expect(keyWords('absence.illNote')).toContain('ill')
    expect(keyWords('billing.fillIn').some((w) => HEALTH_KEY_WORDS.has(w))).toBe(false)
  })
})
