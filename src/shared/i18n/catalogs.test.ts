import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { bookingCatalogues } from './booking'
import elBooking from './el/booking.json'
import elCommon from './el/common.json'
import elPro from './el/pro.json'
import enBooking from './en/booking.json'
import enCommon from './en/common.json'
import enPro from './en/pro.json'
import { NAMESPACES, type Namespace } from './index'
import { proCatalogues } from './pro'

const CATALOGUES: Record<Namespace, { el: unknown; en: unknown }> = {
  common: { el: elCommon, en: enCommon },
  booking: { el: elBooking, en: enBooking },
  pro: { el: elPro, en: enPro },
}

/**
 * What the booking entry bundles statically: Greek `common` + `booking`, gzipped. It sits inside
 * the 120 KB JS budget of the page (SPEC §10); raise it only on purpose, with `npm run size`.
 */
const BOOKING_TEXT_BUDGET_BYTES = 6 * 1024

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  )
}

function texts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(texts)
}

describe.each(NAMESPACES)('i18n namespace %s', (ns) => {
  const { el, en } = CATALOGUES[ns]

  it('Greek and English have exactly the same keys', () => {
    expect(keys(en).sort()).toEqual(keys(el).sort())
  })

  it('no translation is empty and every leaf is text', () => {
    const all = [...texts(el), ...texts(en)]
    expect(all.length).toBe(keys(el).length + keys(en).length)
    expect(all.every((text) => text.trim().length > 0)).toBe(true)
  })

  it('never names the second factor TOTP, MFA or 2FA', () => {
    expect([...texts(el), ...texts(en)].filter((text) => /TOTP|MFA|2FA/.test(text))).toEqual([])
  })
})

describe('what each entry loads', () => {
  it('the booking page ships common + booking only, in both languages', async () => {
    expect(Object.keys(bookingCatalogues.el).sort()).toEqual(['booking', 'common'])
    expect(Object.keys(await bookingCatalogues.loadEn()).sort()).toEqual(['booking', 'common'])
    const source = readFileSync(join(process.cwd(), 'src', 'shared', 'i18n', 'booking.ts'), 'utf8')
    expect(source).not.toMatch(/pro\.json/)
  })

  it('the pro app ships every namespace', async () => {
    expect(Object.keys(proCatalogues.el).sort()).toEqual([...NAMESPACES].sort())
    expect(Object.keys(await proCatalogues.loadEn()).sort()).toEqual([...NAMESPACES].sort())
  })

  it(`the booking page texts stay under ${BOOKING_TEXT_BUDGET_BYTES / 1024} KB gzip`, () => {
    const shipped = JSON.stringify(bookingCatalogues.el)
    expect(gzipSync(shipped, { level: 9 }).length).toBeLessThanOrEqual(BOOKING_TEXT_BUDGET_BYTES)
  })
})
