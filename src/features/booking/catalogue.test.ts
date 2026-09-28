import { describe, expect, it } from 'vitest'
import { initialOf, serviceGroups, staffPlan, termsFor } from './catalogue'
import type { Catalogue } from './schema'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const CATALOGUE: Catalogue = {
  business: {
    id: id(1),
    slug: 'demo-barber',
    name: 'Demo Barber',
    vertical: 'barber',
    timezone: 'Europe/Athens',
    locale: 'el',
    currency: 'EUR',
    theme: {},
    address: null,
    maps_url: null,
    phone_e164: null,
    min_notice_min: 60,
    max_advance_days: 60,
    allow_any_staff: true,
  },
  categories: [
    { id: id(201), name: 'Μαλλιά', sort: 0 },
    { id: id(202), name: 'Άδεια κατηγορία', sort: 1 },
  ],
  services: [
    {
      id: id(300),
      category_id: null,
      name: 'Χωρίς κατηγορία',
      duration_min: 10,
      price_cents: 500,
      sort: 0,
    },
    {
      id: id(301),
      category_id: id(201),
      name: 'Κούρεμα',
      duration_min: 30,
      price_cents: 1300,
      sort: 1,
    },
    {
      id: id(302),
      category_id: id(201),
      name: 'Ξύρισμα',
      duration_min: 20,
      price_cents: 900,
      sort: 2,
    },
  ],
  staff: [
    {
      id: id(101),
      display_name: 'Νίκος',
      color: '#C8A15A',
      sort: 0,
      services: [{ service_id: id(301), duration_min: 30, price_cents: 1300 }],
    },
    {
      id: id(102),
      display_name: 'Άλεξ',
      color: null,
      sort: 1,
      services: [
        { service_id: id(301), duration_min: 35, price_cents: 1500 },
        { service_id: id(302), duration_min: 20, price_cents: 900 },
      ],
    },
  ],
}

describe('serviceGroups', () => {
  it('lists uncategorised services first and skips empty categories', () => {
    const groups = serviceGroups(CATALOGUE)
    expect(groups.map((group) => group.category?.name ?? null)).toEqual([null, 'Μαλλιά'])
    expect(groups[1]?.services.map((service) => service.name)).toEqual(['Κούρεμα', 'Ξύρισμα'])
  })
})

describe('staffPlan', () => {
  it('asks for a staff member only when two or more offer the service', () => {
    expect(staffPlan(CATALOGUE, id(301))).toEqual({ staffStep: true, staffId: null })
    expect(staffPlan(CATALOGUE, id(302))).toEqual({ staffStep: false, staffId: id(102) })
    expect(staffPlan(CATALOGUE, id(300))).toEqual({ staffStep: false, staffId: null })
  })
})

describe('termsFor', () => {
  it('uses the staff member’s own duration and price, else the service defaults', () => {
    expect(termsFor(CATALOGUE, id(301), id(102))).toEqual({
      service_id: id(301),
      duration_min: 35,
      price_cents: 1500,
    })
    expect(termsFor(CATALOGUE, id(301), null)).toEqual({ duration_min: 30, price_cents: 1300 })
    expect(termsFor(CATALOGUE, id(999), null)).toBeNull()
  })
})

describe('initialOf', () => {
  it('is the first letter, in capitals', () => {
    expect(initialOf(' άλεξ')).toBe('Ά')
    expect(initialOf('')).toBe('')
  })
})
