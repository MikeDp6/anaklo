import { describe, expect, it } from 'vitest'
import {
  currencyCodes,
  currencyName,
  IdentityFormSchema,
  identityChanges,
  slugInput,
  timeZoneOptions,
  toIdentityChange,
} from './identity'
import type { IdentityValues } from './schema'

// Test data only: the demo shop's identity.
const STORED: IdentityValues = {
  slug: 'demo-barber',
  timeZone: 'Europe/Athens',
  currency: 'EUR',
}

describe('identityChanges (contract 1.7 §6.9: the confirm step lists only what changes)', () => {
  it('nothing different → nothing to confirm (also after case and spaces)', () => {
    expect(identityChanges(STORED, { ...STORED })).toEqual([])
    expect(
      identityChanges(STORED, {
        slug: ' Demo-Barber ',
        timeZone: 'Europe/Athens',
        currency: 'eur',
      }),
    ).toEqual([])
  })

  it('only the changed fields, in the order slug, zone, currency, as the server stores them', () => {
    expect(
      identityChanges(STORED, { slug: ' New-Name ', timeZone: 'Europe/Athens', currency: 'usd' }),
    ).toEqual([
      { field: 'slug', from: 'demo-barber', to: 'new-name' },
      { field: 'currency', from: 'EUR', to: 'USD' },
    ])
    expect(
      identityChanges(STORED, { slug: 'demo-barber', timeZone: 'Europe/London', currency: 'EUR' }),
    ).toEqual([{ field: 'timezone', from: 'Europe/Athens', to: 'Europe/London' }])
  })

  it('the RPC gets the changed fields only', () => {
    expect(toIdentityChange([{ field: 'timezone', from: 'Europe/Athens', to: 'UTC' }])).toEqual({
      timeZone: 'UTC',
    })
    expect(
      toIdentityChange([
        { field: 'slug', from: 'a', to: 'b-c' },
        { field: 'currency', from: 'EUR', to: 'USD' },
      ]),
    ).toEqual({ slug: 'b-c', currency: 'USD' })
    expect(toIdentityChange([])).toEqual({})
  })
})

describe('the form', () => {
  it('the slug is lower-cased as typed', () => {
    expect(slugInput('My-Shop')).toBe('my-shop')
  })

  it('an empty slug is refused with the required text; the format is the server’s', () => {
    const empty = IdentityFormSchema.safeParse({ ...STORED, slug: '   ' })
    expect(empty.success).toBe(false)
    expect(empty.error?.issues[0]?.message).toBe('form.errors.required')
    expect(IdentityFormSchema.safeParse({ ...STORED, slug: 'Not a slug!' }).success).toBe(true)
  })
})

describe('the zone and currency lists', () => {
  it('always include the stored value, sorted and without duplicates', () => {
    expect(timeZoneOptions('Europe/Athens', ['UTC', 'Europe/London', 'Europe/Athens'])).toEqual([
      'Europe/Athens',
      'Europe/London',
      'UTC',
    ])
    expect(timeZoneOptions('Europe/Kiev', ['Europe/Kyiv'])).toEqual(['Europe/Kiev', 'Europe/Kyiv'])
    expect(timeZoneOptions('Europe/Athens', [])).toEqual(['Europe/Athens'])
    expect(currencyCodes('EUR', ['USD', 'GBP'])).toEqual(['EUR', 'GBP', 'USD'])
  })

  it('come from the engine by default', () => {
    expect(timeZoneOptions('Europe/Athens')).toContain('Europe/London')
    expect(currencyCodes('EUR')).toContain('USD')
  })

  it('names a currency in the UI language, or nothing for an unknown code', () => {
    expect(currencyName('EUR', 'en')).toMatch(/euro/i)
    expect(currencyName('XXQ', 'en')).toBeNull()
  })
})
