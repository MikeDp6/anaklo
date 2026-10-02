import { z } from 'zod/mini'
import { HOUR_MINUTE, minutesOf } from '@fn-shared/hours.ts'
import { REMINDER_MODES } from '@/shared/lib/domain'
import type { BookingPolicy, BookingPolicyInput } from './schema'

/** The values the selects offer (contract 1.6 §4.8); the database CHECKs decide (0001). */
export const SLOT_STEPS = [5, 10, 15, 20, 30, 60] as const
export const NOTICE_PRESETS = [
  0, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 4320, 10080,
] as const
export const AUTO_COMPLETE_PRESETS = [0, 15, 30, 60, 120, 240, 720, 1440] as const

/** Ranges of the numeric fields = the CHECKs of `businesses` (0001, 0007). */
export const POLICY_RANGES = {
  minNoticeMin: { min: 0, max: 10080 },
  maxAdvanceDays: { min: 1, max: 365 },
  cancelMinNoticeMin: { min: 0, max: 10080 },
  autoCompleteAfterMin: { min: 0, max: 10080 },
  correctionWindowDays: { min: 0, max: 30 },
} as const

/** A quiet window lasts 1–12 hours, possibly across midnight (CHECK `businesses_quiet_hours`). */
const QUIET_MIN_MINUTES = 60
const QUIET_MAX_MINUTES = 720
const DAY_MINUTES = 1440

/** Messages are i18n keys of the `pro` namespace; `range` takes `{ min, max }` of the field. */
export const POLICY_ERRORS = {
  range: 'form.errors.range',
  required: 'form.errors.required',
  quietEqual: 'policy.errors.quietEqual',
  quietWindow: 'policy.errors.quietWindow',
} as const

export type PolicyErrorKey = (typeof POLICY_ERRORS)[keyof typeof POLICY_ERRORS]

/**
 * The form of `BookingPolicyForm` (contract 1.6 §4.8). Selects and number inputs hold text; the
 * keys are the camelCase names of the `businesses` columns (the provisioning map of §5.1 relies
 * on that).
 */
export const BookingPolicyFormSchema = z
  .object({
    bookingEnabled: z.boolean(),
    slotStepMin: z.string(),
    minNoticeMin: z.string(),
    maxAdvanceDays: z.string(),
    cancelMinNoticeMin: z.string(),
    autoCompleteAfterMin: z.string(),
    correctionWindowDays: z.string(),
    allowAnyStaff: z.boolean(),
    messagingEnabled: z.boolean(),
    reminderMode: z.enum(REMINDER_MODES),
    quietStart: z.string(),
    quietEnd: z.string(),
  })
  .check(
    z.superRefine((form, ctx) => {
      const issue = (path: string, message: PolicyErrorKey) =>
        ctx.addIssue({ code: 'custom', path: [path], message, input: form })
      if (!SLOT_STEPS.some((step) => String(step) === form.slotStepMin)) {
        issue('slotStepMin', POLICY_ERRORS.required)
      }
      for (const [field, range] of Object.entries(POLICY_RANGES) as [
        keyof typeof POLICY_RANGES,
        { min: number; max: number },
      ][]) {
        const text = form[field].trim()
        const value = Number(text)
        if (!/^\d+$/.test(text) || value < range.min || value > range.max) {
          issue(field, POLICY_ERRORS.range)
        }
      }
      if (!HOUR_MINUTE.test(form.quietStart)) issue('quietStart', POLICY_ERRORS.required)
      if (!HOUR_MINUTE.test(form.quietEnd)) issue('quietEnd', POLICY_ERRORS.required)
      if (!HOUR_MINUTE.test(form.quietStart) || !HOUR_MINUTE.test(form.quietEnd)) return
      const length =
        (minutesOf(form.quietEnd) - minutesOf(form.quietStart) + DAY_MINUTES) % DAY_MINUTES
      if (length === 0) issue('quietEnd', POLICY_ERRORS.quietEqual)
      else if (length < QUIET_MIN_MINUTES || length > QUIET_MAX_MINUTES) {
        issue('quietEnd', POLICY_ERRORS.quietWindow)
      }
    }),
  )

export type BookingPolicyFormValues = z.infer<typeof BookingPolicyFormSchema>

export function toPolicyForm(policy: BookingPolicy): BookingPolicyFormValues {
  return {
    bookingEnabled: policy.bookingEnabled,
    slotStepMin: String(policy.slotStepMin),
    minNoticeMin: String(policy.minNoticeMin),
    maxAdvanceDays: String(policy.maxAdvanceDays),
    cancelMinNoticeMin: String(policy.cancelMinNoticeMin),
    autoCompleteAfterMin: String(policy.autoCompleteAfterMin),
    correctionWindowDays: String(policy.correctionWindowDays),
    allowAnyStaff: policy.allowAnyStaff,
    messagingEnabled: policy.messagingEnabled,
    reminderMode: policy.reminderMode,
    quietStart: policy.quietStart,
    quietEnd: policy.quietEnd,
  }
}

/** Only for values that passed the schema. */
export function toPolicyInput(form: BookingPolicyFormValues): BookingPolicyInput {
  return {
    bookingEnabled: form.bookingEnabled,
    slotStepMin: Number(form.slotStepMin),
    minNoticeMin: Number(form.minNoticeMin.trim()),
    maxAdvanceDays: Number(form.maxAdvanceDays.trim()),
    cancelMinNoticeMin: Number(form.cancelMinNoticeMin.trim()),
    autoCompleteAfterMin: Number(form.autoCompleteAfterMin.trim()),
    correctionWindowDays: Number(form.correctionWindowDays.trim()),
    allowAnyStaff: form.allowAnyStaff,
    messagingEnabled: form.messagingEnabled,
    reminderMode: form.reminderMode,
    quietStart: form.quietStart,
    quietEnd: form.quietEnd,
  }
}

/**
 * The values a select offers: the presets, plus the stored value when provisioning set one that
 * is not a preset (D18: shown as an extra option and saved back unchanged), in ascending order.
 */
export function presetOptions(presets: readonly number[], stored: number | null): number[] {
  const values = new Set<number>(presets)
  if (stored !== null && Number.isInteger(stored)) values.add(stored)
  return [...values].sort((a, b) => a - b)
}
