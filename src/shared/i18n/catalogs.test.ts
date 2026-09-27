import { describe, expect, it } from 'vitest'
import el from './el.json'
import en from './en.json'

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('i18n catalogues', () => {
  it('Greek and English have exactly the same keys', () => {
    expect(keys(en).sort()).toEqual(keys(el).sort())
  })

  it('no translation is empty', () => {
    const values = [...keys(el), ...keys(en)]
    expect(values.length).toBeGreaterThan(0)
    const flat = (catalogue: unknown): string[] =>
      typeof catalogue === 'string' ? [catalogue] : Object.values(catalogue as object).flatMap(flat)
    expect([...flat(el), ...flat(en)].every((text) => text.trim().length > 0)).toBe(true)
  })
})
