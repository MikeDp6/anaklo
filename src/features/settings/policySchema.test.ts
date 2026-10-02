import { describe, expect, it } from 'vitest'
import {
  BookingPolicyFormSchema,
  NOTICE_PRESETS,
  POLICY_ERRORS,
  presetOptions,
  toPolicyForm,
  toPolicyInput,
  type BookingPolicyFormValues,
} from './policySchema'
import type { BookingPolicy } from './schema'

const POLICY: BookingPolicy = {
  id: '00000000-0000-4000-8000-000000000001',
  timeZone: 'Europe/Athens',
  bookingEnabled: true,
  slotStepMin: 15,
  minNoticeMin: 60,
  maxAdvanceDays: 60,
  cancelMinNoticeMin: 120,
  autoCompleteAfterMin: 720,
  correctionWindowDays: 3,
  allowAnyStaff: true,
  messagingEnabled: true,
  quietStart: '22:00',
  quietEnd: '09:00',
  reminderMode: '24h',
}

function errorsOf(partial: Partial<BookingPolicyFormValues>): Record<string, string> {
  const result = BookingPolicyFormSchema.safeParse({ ...toPolicyForm(POLICY), ...partial })
  if (result.success) return {}
  return Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]))
}

describe('BookingPolicyFormSchema (contract 1.6 §4.8)', () => {
  it('the stored policy passes and round-trips to the same input', () => {
    expect(errorsOf({})).toEqual({})
    expect({
      ...toPolicyInput(toPolicyForm(POLICY)),
      id: POLICY.id,
      timeZone: POLICY.timeZone,
    }).toEqual(POLICY)
  })

  it('a stored value that is not a preset is offered and saved back unchanged (D18)', () => {
    expect(presetOptions(NOTICE_PRESETS, 45)).toContain(45)
    expect(presetOptions(NOTICE_PRESETS, 45).indexOf(45)).toBe(
      presetOptions(NOTICE_PRESETS, 45).indexOf(60) - 1,
    )
    expect(presetOptions(NOTICE_PRESETS, 60)).toEqual([...NOTICE_PRESETS])
    const stored = { ...POLICY, minNoticeMin: 45, autoCompleteAfterMin: 90 }
    expect(errorsOf(toPolicyForm(stored))).toEqual({})
    expect(toPolicyInput(toPolicyForm(stored))).toMatchObject({
      minNoticeMin: 45,
      autoCompleteAfterMin: 90,
    })
  })

  it('quiet hours: 1–12 hours, across midnight allowed', () => {
    expect(errorsOf({ quietStart: '22:00', quietEnd: '09:00' })).toEqual({}) // 11 h
    expect(errorsOf({ quietStart: '21:00', quietEnd: '09:00' })).toEqual({}) // 12 h
    expect(errorsOf({ quietStart: '20:59', quietEnd: '09:00' })).toEqual({
      quietEnd: POLICY_ERRORS.quietWindow,
    })
    expect(errorsOf({ quietStart: '13:00', quietEnd: '14:00' })).toEqual({}) // 1 h
    expect(errorsOf({ quietStart: '23:30', quietEnd: '00:29' })).toEqual({
      quietEnd: POLICY_ERRORS.quietWindow,
    })
  })

  it('equal ends are rejected', () => {
    expect(errorsOf({ quietStart: '22:00', quietEnd: '22:00' })).toEqual({
      quietEnd: POLICY_ERRORS.quietEqual,
    })
  })

  it('numbers within the database ranges, whole numbers only', () => {
    expect(errorsOf({ maxAdvanceDays: '0' })).toEqual({ maxAdvanceDays: POLICY_ERRORS.range })
    expect(errorsOf({ maxAdvanceDays: '365' })).toEqual({})
    expect(errorsOf({ maxAdvanceDays: '366' })).toEqual({ maxAdvanceDays: POLICY_ERRORS.range })
    expect(errorsOf({ correctionWindowDays: '31' })).toEqual({
      correctionWindowDays: POLICY_ERRORS.range,
    })
    expect(errorsOf({ correctionWindowDays: '2.5' })).toEqual({
      correctionWindowDays: POLICY_ERRORS.range,
    })
    expect(errorsOf({ slotStepMin: '7' })).toEqual({ slotStepMin: POLICY_ERRORS.required })
  })
})
