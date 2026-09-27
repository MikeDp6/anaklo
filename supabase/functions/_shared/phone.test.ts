import { describe, expect, it } from 'vitest'
import { formatPhone, isGreekMobile, normalizePhone } from './phone.ts'

describe('normalizePhone', () => {
  it.each([
    ['6941234567', '+306941234567'],
    ['694 123 4567', '+306941234567'],
    ['694-123-4567', '+306941234567'],
    ['+30 694 123 4567', '+306941234567'],
    ['0030 694 123 4567', '+306941234567'],
    ['306941234567', '+306941234567'],
    ['2101234567', '+302101234567'],
    ['(2610) 123456', '+302610123456'],
    ['+44 7700 900123', '+447700900123'],
    ['0049 30 1234567', '+49301234567'],
  ])('%j → %s', (input, e164) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164 })
  })

  it('cleans invisible marks and fancy dashes from copied numbers', () => {
    const bidi = (text: string) =>
      `${String.fromCodePoint(0x202a)}${text}${String.fromCodePoint(0x202c)}`
    const zeroWidth = String.fromCodePoint(0x200b)
    const nbHyphen = String.fromCodePoint(0x2011)
    expect(normalizePhone(bidi('+30 694 123 4567'))).toEqual({ ok: true, e164: '+306941234567' })
    expect(normalizePhone(`694${zeroWidth}1234567`)).toEqual({ ok: true, e164: '+306941234567' })
    expect(normalizePhone(`694${nbHyphen}123${nbHyphen}4567`)).toEqual({
      ok: true,
      e164: '+306941234567',
    })
  })

  it.each(['', '   '])('reports empty input %j', (input) => {
    expect(normalizePhone(input)).toEqual({ ok: false, reason: 'empty' })
  })

  it.each(['12345', '5941234567', '69412345', '+30 594 123 4567', 'abc', '694123456a', '+30+694'])(
    'rejects %j',
    (input) => {
      expect(normalizePhone(input)).toEqual({ ok: false, reason: 'invalid' })
    },
  )
})

describe('isGreekMobile', () => {
  it('accepts only +3069 numbers (SMS allow-list default)', () => {
    expect(isGreekMobile('+306941234567')).toBe(true)
    expect(isGreekMobile('+302101234567')).toBe(false)
    expect(isGreekMobile('+447700900123')).toBe(false)
  })
})

describe('formatPhone', () => {
  it('groups Greek numbers', () => {
    expect(formatPhone('+306941234567')).toBe('+30 694 123 4567')
    expect(formatPhone('+302101234567')).toBe('+30 210 123 4567')
  })

  it('leaves other countries unchanged', () => {
    expect(formatPhone('+447700900123')).toBe('+447700900123')
  })
})
