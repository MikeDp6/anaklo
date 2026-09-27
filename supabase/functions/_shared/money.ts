/**
 * Money is always an integer number of cents (CLAUDE.md rule 5). Never store or add floats.
 * Division by 100 happens only at the formatting edge.
 */

export type Cents = number

export function isCents(value: number): value is Cents {
  return Number.isSafeInteger(value)
}

export function assertCents(value: number): asserts value is Cents {
  if (!isCents(value)) throw new TypeError(`Expected integer cents, got ${String(value)}`)
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0
  for (const value of values) {
    assertCents(value)
    total += value
  }
  assertCents(total)
  return total
}

export function multiplyCents(cents: Cents, quantity: number): Cents {
  assertCents(cents)
  if (!Number.isSafeInteger(quantity))
    throw new TypeError(`Expected an integer quantity, got ${quantity}`)
  const result = cents * quantity
  assertCents(result)
  return result
}

export function formatMoney(cents: Cents, currency: string, locale: string): string {
  assertCents(cents)
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)
}

/**
 * Parses what a person types ("13", "13,5", "13,50", "1.300,00", "13.50 €") into cents without
 * floating point. A comma, when present, is the decimal separator (Greek usage) and dots are
 * thousands separators; otherwise a single dot followed by 1–2 digits is the decimal separator.
 * A space inside the number is accepted only as a thousands separator ("1 300,50"); "13 50" is
 * ambiguous and rejected rather than read as 1350. Returns null for anything ambiguous or invalid.
 */
export function parseMoney(input: string): Cents | null {
  let cleaned = input.replace(/^[\s\u20ac]+|[\s\u20ac]+$/g, '')
  if (cleaned === '') return null
  if (/\s/.test(cleaned)) {
    if (!/^\d{1,3}(\s\d{3})+(,\d{1,2})?$/.test(cleaned)) return null
    cleaned = cleaned.replace(/\s/g, '')
  }

  let integerPart: string
  let fractionPart: string

  if (cleaned.includes(',')) {
    const [whole, fraction, ...rest] = cleaned.split(',')
    if (rest.length > 0 || whole === undefined || fraction === undefined) return null
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(whole)) return null
    integerPart = whole.replace(/\./g, '')
    fractionPart = fraction
  } else {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
    if (!match) return null
    integerPart = match[1] ?? ''
    fractionPart = match[2] ?? ''
  }

  if (!/^\d+$/.test(integerPart) || !/^\d{0,2}$/.test(fractionPart)) return null

  const cents = Number(integerPart) * 100 + Number(fractionPart.padEnd(2, '0'))
  return isCents(cents) ? cents : null
}
