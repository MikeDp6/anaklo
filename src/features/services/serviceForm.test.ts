import { describe, expect, it } from 'vitest'
import type { StaffMember } from '@/features/staff/schema'
import type { CatalogueService, Category } from './schema'
import { groupServices, offerStaff, toServiceForm } from './serviceForm'

// Test data only (synthetic ids).
const HAIR: Category = { id: 'c1', name: 'Μαλλιά', sort: 0 }
const BEARD: Category = { id: 'c2', name: 'Γένια', sort: 1 }
const A: StaffMember = { id: 's1', displayName: 'Σταύρος', color: null, sort: 0, active: true }
const B: StaffMember = { id: 's2', displayName: 'Μάριος', color: null, sort: 1, active: true }
const GONE: StaffMember = { id: 's3', displayName: 'Παλιός', color: null, sort: 2, active: false }

function service(overrides: Partial<CatalogueService> & { id: string }): CatalogueService {
  return {
    name: overrides.id,
    categoryId: null,
    durationMin: 30,
    bufferAfterMin: 0,
    priceCents: 1300,
    onlineBookable: true,
    active: true,
    sort: 0,
    offers: [],
    ...overrides,
  }
}

describe('groupServices (contract 1.6 §4.3)', () => {
  it('active by category order, «Χωρίς κατηγορία» after them, inactive last; empty groups out', () => {
    const groups = groupServices(
      [
        service({ id: 'beard', categoryId: BEARD.id, sort: 2 }),
        service({ id: 'cut', categoryId: HAIR.id, sort: 0 }),
        service({ id: 'old', categoryId: HAIR.id, sort: 1, active: false }),
        service({ id: 'free', categoryId: null, sort: 3 }),
        service({ id: 'cut2', categoryId: HAIR.id, sort: 4 }),
      ],
      [BEARD, HAIR, { id: 'c3', name: 'Κενή', sort: 2 }],
    )
    expect(
      groups.map((group) => [
        group.kind === 'category' ? group.category.name : group.kind,
        group.services.map((one) => one.id),
      ]),
    ).toEqual([
      ['Μαλλιά', ['cut', 'cut2']],
      ['Γένια', ['beard']],
      ['none', ['free']],
      ['inactive', ['old']],
    ])
  })
})

describe('toServiceForm', () => {
  it('a new service: 30 minutes, no break, online, every active staff member checked', () => {
    const form = toServiceForm(null, [A, B, GONE], 'el')
    expect(form).toMatchObject({
      name: '',
      categoryId: '',
      durationMin: '30',
      bufferAfterMin: '0',
      priceCents: '',
      onlineBookable: true,
      active: true,
    })
    expect(form.offers.map((offer) => [offer.staffId, offer.checked])).toEqual([
      ['s1', true],
      ['s2', true],
    ])
  })

  it('an existing one: money via formatMoneyInput, custom terms prefilled, linked inactive staff shown', () => {
    const existing = service({
      id: 'cut',
      categoryId: HAIR.id,
      priceCents: 1300,
      offers: [
        { staffId: 's2', customDurationMin: 35, customPriceCents: 1450 },
        { staffId: 's3', customDurationMin: null, customPriceCents: null },
      ],
    })
    expect(offerStaff(existing, [A, B, GONE]).map((member) => member.id)).toEqual([
      's1',
      's2',
      's3',
    ])
    const form = toServiceForm(existing, [A, B, GONE], 'el')
    expect(form.priceCents).toBe('13,00')
    expect(form.categoryId).toBe(HAIR.id)
    expect(form.offers).toEqual([
      { staffId: 's1', checked: false, customDurationMin: '', customPriceCents: '' },
      { staffId: 's2', checked: true, customDurationMin: '35', customPriceCents: '14,50' },
      { staffId: 's3', checked: true, customDurationMin: '', customPriceCents: '' },
    ])
    expect(toServiceForm(existing, [A], 'en').priceCents).toBe('13.00')
  })
})
