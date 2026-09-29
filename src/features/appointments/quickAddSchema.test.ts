import { describe, expect, it } from 'vitest'
import {
  EMPTY_QUICK_ADD,
  isClientStepValid,
  QUICK_ADD_ERRORS,
  QuickAddForm,
  quickAddPayload,
  type QuickAddValues,
} from './quickAddSchema'

// Test data only (synthetic ids and the +30 6900 000 xxx range of the seed).
const SERVICE = '00000000-0000-4000-8000-000000000301'
const STAFF = '00000000-0000-4000-8000-000000000101'
const CLIENT = '00000000-0000-4000-8000-00000000c001'
const STARTS_AT = '2026-09-29T07:00:00.000Z'

const chosen: QuickAddValues = {
  ...EMPTY_QUICK_ADD,
  serviceId: SERVICE,
  staffId: STAFF,
  startsAt: STARTS_AT,
}

function issues(values: QuickAddValues): Record<string, string> {
  const result = QuickAddForm.safeParse(values)
  if (result.success) return {}
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  )
}

describe('QuickAddForm (zod/mini, used by RHF through zodResolver)', () => {
  it('accepts an existing client', () => {
    const values = { ...chosen, clientId: CLIENT, clientName: 'Γιώργος Π.' }
    expect(QuickAddForm.safeParse(values).success).toBe(true)
    expect(
      quickAddPayload(values, {
        locale: 'el',
        allowOutsideHours: false,
        allowBufferOverlap: false,
      }),
    ).toEqual({
      serviceIds: [SERVICE],
      staffId: STAFF,
      startsAt: STARTS_AT,
      source: 'phone',
      allowOutsideHours: false,
      allowBufferOverlap: false,
      client: { kind: 'existing', clientId: CLIENT },
    })
  })

  it('requires the chosen client in existing mode', () => {
    expect(issues(chosen)).toEqual({ clientId: QUICK_ADD_ERRORS.clientRequired })
  })

  it('accepts a new client with a Greek mobile, sent in E.164', () => {
    const values: QuickAddValues = {
      ...chosen,
      clientMode: 'new',
      clientName: '  Νίκος Νέος ',
      phone: '690 000 0999',
    }
    expect(QuickAddForm.safeParse(values).success).toBe(true)
    expect(isClientStepValid(values)).toBe(true)
    expect(
      quickAddPayload(values, { locale: 'el', allowOutsideHours: false, allowBufferOverlap: false })
        .client,
    ).toEqual({
      kind: 'new',
      fullName: 'Νίκος Νέος',
      phoneE164: '+306900000999',
      locale: 'el',
    })
  })

  it('accepts a new client without a phone', () => {
    const values: QuickAddValues = { ...chosen, clientMode: 'new', clientName: 'Walk-in Κώστας' }
    expect(QuickAddForm.safeParse(values).success).toBe(true)
    expect(
      quickAddPayload(values, { locale: 'en', allowOutsideHours: true, allowBufferOverlap: false }),
    ).toMatchObject({
      allowOutsideHours: true,
      client: { kind: 'new', fullName: 'Walk-in Κώστας', phoneE164: null, locale: 'en' },
    })
  })

  it('rejects a new client without a name, or with a wrong phone', () => {
    const values: QuickAddValues = {
      ...chosen,
      clientMode: 'new',
      clientName: '   ',
      phone: '12345',
    }
    expect(issues(values)).toEqual({
      clientName: QUICK_ADD_ERRORS.nameRequired,
      phone: QUICK_ADD_ERRORS.phoneInvalid,
    })
    expect(isClientStepValid(values)).toBe(false)
    expect(issues({ ...values, clientName: 'x'.repeat(121), phone: '' })).toEqual({
      clientName: QUICK_ADD_ERRORS.nameTooLong,
    })
  })

  it('requires service, staff member and time', () => {
    expect(issues({ ...EMPTY_QUICK_ADD, clientId: CLIENT })).toEqual({
      serviceId: QUICK_ADD_ERRORS.serviceRequired,
      staffId: QUICK_ADD_ERRORS.staffRequired,
      startsAt: QUICK_ADD_ERRORS.timeRequired,
    })
  })

  it('every message is a key of the pro namespace', () => {
    for (const key of Object.values(QUICK_ADD_ERRORS)) expect(key).toMatch(/^quickAdd\.errors\./)
  })
})
