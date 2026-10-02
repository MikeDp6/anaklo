import { describe, expect, it } from 'vitest'
import { formatMoney, formatMoneyInput, multiplyCents, parseMoney, sumCents } from './money.ts'

describe('parseMoney', () => {
  it.each([
    ['13', 1300],
    ['13,5', 1350],
    ['13,50', 1350],
    ['0,05', 5],
    ['13.50', 1350],
    ['1.300,00', 130000],
    ['13,50 €', 1350],
    [' 7 ', 700],
  ])('parses %j as %i cents', (input, cents) => {
    expect(parseMoney(input)).toBe(cents)
  })

  it.each([
    ['1 300', 130000],
    ['1 300,50', 130050],
    ['€ 7', 700],
  ])('accepts spaces only as separators or padding: %j → %i', (input, cents) => {
    expect(parseMoney(input)).toBe(cents)
  })

  it.each([
    '',
    'abc',
    '13,505',
    '1,2,3',
    '-5',
    '13.505',
    '1.30,00',
    '13 50',
    '1 3',
    '1 30,00',
    '13€50',
  ])('rejects %j', (input) => {
    expect(parseMoney(input)).toBeNull()
  })

  it('never goes through floating point (0,29 is exactly 29 cents)', () => {
    expect(parseMoney('0,29')).toBe(29)
    expect(parseMoney('1,15')).toBe(115)
  })
})

describe('cent arithmetic', () => {
  it('sums integer cents', () => {
    expect(sumCents([1300, 700, 5])).toBe(2005)
  })

  it('refuses fractional cents', () => {
    expect(() => sumCents([10.5])).toThrow(TypeError)
    expect(() => multiplyCents(100, 1.5)).toThrow(TypeError)
  })

  it('multiplies by whole quantities', () => {
    expect(multiplyCents(1300, 3)).toBe(3900)
  })
})

describe('formatMoney', () => {
  it('formats euros for Greek users', () => {
    expect(formatMoney(1350, 'EUR', 'el-GR').replace(/\s/g, ' ')).toBe('13,50 €')
  })

  it('formats euros for English users', () => {
    expect(formatMoney(1350, 'EUR', 'en-IE')).toBe('€13.50')
  })
})

describe('formatMoneyInput (contract 1.6 §4.2)', () => {
  it('writes cents with the locale decimal separator, without currency or grouping', () => {
    expect(formatMoneyInput(1300, 'el')).toBe('13,00')
    expect(formatMoneyInput(1300, 'en')).toBe('13.00')
    expect(formatMoneyInput(5, 'el')).toBe('0,05')
    expect(formatMoneyInput(0, 'en')).toBe('0.00')
    expect(formatMoneyInput(9999999, 'el')).toBe('99999,99')
  })

  it('reads back with parseMoney to the same cents', () => {
    for (const cents of [0, 5, 29, 115, 750, 1300, 1350, 130050, 9999999]) {
      for (const locale of ['el', 'en']) {
        expect(parseMoney(formatMoneyInput(cents, locale))).toBe(cents)
      }
    }
  })

  it('refuses fractional cents', () => {
    expect(() => formatMoneyInput(10.5, 'el')).toThrow(TypeError)
  })
})
