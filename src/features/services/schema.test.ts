import { describe, expect, it } from 'vitest'
import {
  parsePrice,
  SaveServiceResponse,
  SERVICE_FORM_ERRORS,
  ServiceFormSchema,
  toSaveServiceArgs,
  toSaveServiceInput,
  toSaveServiceResult,
  type ServiceFormValues,
} from './schema'

// Test data only (synthetic ids).
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const SERVICE = '00000000-0000-4000-8000-000000000301'
const CATEGORY = '00000000-0000-4000-8000-000000000201'
const STAFF_A = '00000000-0000-4000-8000-000000000101'
const STAFF_B = '00000000-0000-4000-8000-000000000102'

const VALID: ServiceFormValues = {
  name: ' Κούρεμα ',
  categoryId: CATEGORY,
  durationMin: '30',
  bufferAfterMin: '5',
  priceCents: '13,50',
  onlineBookable: true,
  active: true,
  offers: [
    { staffId: STAFF_A, checked: true, customDurationMin: '', customPriceCents: '' },
    { staffId: STAFF_B, checked: true, customDurationMin: '35', customPriceCents: '15' },
  ],
}

function issues(values: ServiceFormValues): Record<string, string> {
  const result = ServiceFormSchema.safeParse(values)
  if (result.success) return {}
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  )
}

describe('ServiceFormSchema (contract 1.6 §4.3; CHECKs of 0001)', () => {
  it('a valid form has no issues', () => {
    expect(issues(VALID)).toEqual({})
  })

  it('name 1–80 after trimming', () => {
    expect(issues({ ...VALID, name: '  ' })).toEqual({ name: SERVICE_FORM_ERRORS.name })
    expect(issues({ ...VALID, name: 'Α'.repeat(81) })).toEqual({ name: SERVICE_FORM_ERRORS.name })
    expect(issues({ ...VALID, name: 'Α'.repeat(80) })).toEqual({})
  })

  it.each([
    ['durationMin', '4'],
    ['durationMin', '601'],
    ['durationMin', '30.5'],
    ['durationMin', ''],
    ['bufferAfterMin', '121'],
    ['bufferAfterMin', '-1'],
  ] as const)('%s %j is out of range', (field, value) => {
    expect(issues({ ...VALID, [field]: value })).toEqual({ [field]: SERVICE_FORM_ERRORS.range })
  })

  it('duration 5 and 600, buffer 0 and 120 are the limits', () => {
    expect(issues({ ...VALID, durationMin: '5', bufferAfterMin: '0' })).toEqual({})
    expect(issues({ ...VALID, durationMin: '600', bufferAfterMin: '120' })).toEqual({})
  })

  it('price through parseMoney: 13,50 and 13.5 are 1350; -1, 13 50 and 100000 are refused', () => {
    expect(parsePrice('13,50')).toBe(1350)
    expect(parsePrice('13.5')).toBe(1350)
    expect(parsePrice('0')).toBe(0)
    expect(parsePrice('99.999,99')).toBe(9_999_999)
    for (const bad of ['-1', '13 50', '100000', '', 'δέκα']) {
      expect(parsePrice(bad), bad).toBeNull()
      expect(issues({ ...VALID, priceCents: bad })).toEqual({
        priceCents: SERVICE_FORM_ERRORS.price,
      })
    }
  })

  it('custom terms are checked only on checked rows; empty means the service default', () => {
    const offers = [
      { staffId: STAFF_A, checked: true, customDurationMin: '4', customPriceCents: '-1' },
      { staffId: STAFF_B, checked: false, customDurationMin: '4', customPriceCents: '-1' },
    ]
    expect(issues({ ...VALID, offers })).toEqual({
      'offers.0.customDurationMin': SERVICE_FORM_ERRORS.range,
      'offers.0.customPriceCents': SERVICE_FORM_ERRORS.price,
    })
  })
})

describe('toSaveServiceInput / toSaveServiceArgs', () => {
  it('keeps checked staff only; empty custom → null; money in integer cents', () => {
    const input = toSaveServiceInput(
      {
        ...VALID,
        offers: [
          { staffId: STAFF_A, checked: true, customDurationMin: ' ', customPriceCents: '' },
          { staffId: STAFF_B, checked: false, customDurationMin: '35', customPriceCents: '15' },
        ],
      },
      SERVICE,
    )
    expect(input).toEqual({
      id: SERVICE,
      name: 'Κούρεμα',
      categoryId: CATEGORY,
      durationMin: 30,
      bufferAfterMin: 5,
      priceCents: 1350,
      onlineBookable: true,
      active: true,
      offers: [{ staffId: STAFF_A, customDurationMin: null, customPriceCents: null }],
    })
    expect(toSaveServiceInput({ ...VALID, categoryId: '' }, SERVICE).categoryId).toBeNull()
  })

  it('the RPC arguments have exactly the keys of §2.5.5 (snake_case inside the jsonb)', () => {
    const args = toSaveServiceArgs(BUSINESS, toSaveServiceInput(VALID, SERVICE))
    expect(Object.keys(args).sort()).toEqual([
      'p_business_id',
      'p_offers',
      'p_service',
      'p_service_id',
    ])
    expect(args.p_business_id).toBe(BUSINESS)
    expect(args.p_service_id).toBe(SERVICE)
    expect(args.p_service).toEqual({
      name: 'Κούρεμα',
      category_id: CATEGORY,
      duration_min: 30,
      buffer_after_min: 5,
      price_cents: 1350,
      online_bookable: true,
      active: true,
    })
    expect(args.p_offers).toEqual([
      { staff_id: STAFF_A, custom_duration_min: null, custom_price_cents: null },
      { staff_id: STAFF_B, custom_duration_min: 35, custom_price_cents: 1500 },
    ])
  })

  it('parses the save_service answer', () => {
    const result = toSaveServiceResult(
      SaveServiceResponse.parse({
        id: SERVICE,
        created: true,
        name: 'Κούρεμα',
        category_id: null,
        duration_min: 30,
        buffer_after_min: 0,
        price_cents: 1300,
        online_bookable: false,
        active: true,
        sort: 4,
        offers: [{ staff_id: STAFF_B, custom_duration_min: 35, custom_price_cents: null }],
      }),
    )
    expect(result).toEqual({
      id: SERVICE,
      created: true,
      name: 'Κούρεμα',
      categoryId: null,
      durationMin: 30,
      bufferAfterMin: 0,
      priceCents: 1300,
      onlineBookable: false,
      active: true,
      sort: 4,
      offers: [{ staffId: STAFF_B, customDurationMin: 35, customPriceCents: null }],
    })
  })
})
