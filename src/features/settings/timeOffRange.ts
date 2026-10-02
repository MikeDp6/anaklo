import { z } from 'zod/mini'
import { HOUR_MINUTE } from '@fn-shared/hours.ts'
import {
  addLocalDays,
  localDateTimeToInstant,
  parseLocalDate,
  toLocalDate,
  toLocalTime,
  type LocalDate,
} from '@/shared/lib/dates'
import { TIME_OFF_REASONS } from '@/shared/lib/domain'
import { CONFLICT_HORIZON_MS } from './conflictWindow'
import type { TimeOff, TimeOffReason } from './schema'

/** Messages are i18n keys of the `pro` namespace. */
export const TIME_OFF_ERRORS = {
  staffRequired: 'timeOff.errors.staffRequired',
  dateRequired: 'timeOff.errors.dateRequired',
  timeRequired: 'timeOff.errors.timeRequired',
  endBeforeStart: 'form.errors.endBeforeStart',
  endPast: 'timeOff.errors.endPast',
  tooLong: 'timeOff.errors.tooLong',
} as const

export type TimeOffErrorKey = (typeof TIME_OFF_ERRORS)[keyof typeof TIME_OFF_ERRORS]

/** `TimeOffSheet`'s form. Dates and times are business-local (`type="date"`, `type="time"`). */
export interface TimeOffFormValues {
  staffId: string
  reason: TimeOffReason
  allDay: boolean
  fromDate: string
  toDate: string
  fromTime: string
  toTime: string
}

function isDate(value: string): boolean {
  try {
    parseLocalDate(value)
    return true
  } catch {
    return false
  }
}

/**
 * The instants of the form (contract 1.6 §4.7): all day = `[from 00:00, (to + 1) 00:00)` local,
 * else the given local times; DST days are 23 or 25 hours long (calendar arithmetic only).
 * Only for values that passed the schema.
 */
export function toTimeOffRange(
  form: Pick<TimeOffFormValues, 'allDay' | 'fromDate' | 'toDate' | 'fromTime' | 'toTime'>,
  timeZone: string,
): { startsAt: string; endsAt: string } {
  const start = form.allDay
    ? localDateTimeToInstant(form.fromDate, '00:00', timeZone)
    : localDateTimeToInstant(form.fromDate, form.fromTime, timeZone)
  const end = form.allDay
    ? localDateTimeToInstant(addLocalDays(form.toDate, 1), '00:00', timeZone)
    : localDateTimeToInstant(form.toDate, form.toTime, timeZone)
  return { startsAt: start.toISOString(), endsAt: end.toISOString() }
}

/**
 * The form's schema for React Hook Form (`zodResolver`). A new time off must end after `now`; an
 * existing one may be corrected even if it has started. At most 366 days = 8784 hours (every range
 * of 366 local dates fits: it always contains a spring DST change): the conflicts of a saved time
 * off are then always listed in full (`schedule_conflicts` answers 366 days at most); a longer
 * absence is a deactivation. The
 * database re-checks the order and the overlap with the staff member's other time off
 * (`time_off_no_overlap` → `23P01`).
 */
export function timeOffFormSchema(options: { timeZone: string; now: Date; isNew: boolean }) {
  return z
    .object({
      staffId: z.string(),
      reason: z.enum(TIME_OFF_REASONS),
      allDay: z.boolean(),
      fromDate: z.string(),
      toDate: z.string(),
      fromTime: z.string(),
      toTime: z.string(),
    })
    .check(
      z.superRefine((form, ctx) => {
        const issue = (path: string, message: TimeOffErrorKey) =>
          ctx.addIssue({ code: 'custom', path: [path], message, input: form })
        if (form.staffId === '') issue('staffId', TIME_OFF_ERRORS.staffRequired)
        const datesOk = isDate(form.fromDate) && isDate(form.toDate)
        if (!isDate(form.fromDate)) issue('fromDate', TIME_OFF_ERRORS.dateRequired)
        if (!isDate(form.toDate)) issue('toDate', TIME_OFF_ERRORS.dateRequired)
        const timesOk =
          form.allDay || (HOUR_MINUTE.test(form.fromTime) && HOUR_MINUTE.test(form.toTime))
        if (!form.allDay) {
          if (!HOUR_MINUTE.test(form.fromTime)) issue('fromTime', TIME_OFF_ERRORS.timeRequired)
          if (!HOUR_MINUTE.test(form.toTime)) issue('toTime', TIME_OFF_ERRORS.timeRequired)
        }
        if (!datesOk || !timesOk) return
        const { startsAt, endsAt } = toTimeOffRange(form, options.timeZone)
        const end = Date.parse(endsAt)
        if (end <= Date.parse(startsAt)) {
          issue(form.allDay ? 'toDate' : 'toTime', TIME_OFF_ERRORS.endBeforeStart)
        } else if (end - Date.parse(startsAt) > CONFLICT_HORIZON_MS) {
          issue(form.allDay ? 'toDate' : 'toTime', TIME_OFF_ERRORS.tooLong)
        } else if (options.isNew && end <= options.now.getTime()) {
          issue(form.allDay ? 'toDate' : 'toTime', TIME_OFF_ERRORS.endPast)
        }
      }),
    )
}

function isLocalMidnight(instant: Date, timeZone: string): boolean {
  return toLocalTime(instant, timeZone) === '00:00'
}

/** The form of an existing row: whole local days show as «Όλη μέρα». */
export function toTimeOffForm(timeOff: TimeOff, timeZone: string): TimeOffFormValues {
  const start = new Date(timeOff.startsAt)
  const end = new Date(timeOff.endsAt)
  const allDay = isLocalMidnight(start, timeZone) && isLocalMidnight(end, timeZone)
  return {
    staffId: timeOff.staffId,
    reason: timeOff.reason,
    allDay,
    fromDate: toLocalDate(start, timeZone),
    toDate: allDay ? addLocalDays(toLocalDate(end, timeZone), -1) : toLocalDate(end, timeZone),
    fromTime: allDay ? '' : toLocalTime(start, timeZone),
    toTime: allDay ? '' : toLocalTime(end, timeZone),
  }
}

/** A new form: today, all day, «Διακοπές». */
export function newTimeOffForm(staffId: string, today: LocalDate): TimeOffFormValues {
  return {
    staffId,
    reason: 'vacation',
    allDay: true,
    fromDate: today,
    toDate: today,
    fromTime: '',
    toTime: '',
  }
}

/** How a row reads in the list: whole days, times within one date, or two instants. */
export type TimeOffSpan =
  | { readonly kind: 'days'; readonly from: LocalDate; readonly to: LocalDate }
  | { readonly kind: 'times'; readonly date: LocalDate; readonly from: string; readonly to: string }
  | {
      readonly kind: 'instants'
      readonly fromDate: LocalDate
      readonly fromTime: string
      readonly toDate: LocalDate
      readonly toTime: string
    }

export function timeOffSpan(timeOff: TimeOff, timeZone: string): TimeOffSpan {
  const form = toTimeOffForm(timeOff, timeZone)
  if (form.allDay) return { kind: 'days', from: form.fromDate, to: form.toDate }
  if (form.fromDate === form.toDate) {
    return { kind: 'times', date: form.fromDate, from: form.fromTime, to: form.toTime }
  }
  return {
    kind: 'instants',
    fromDate: form.fromDate,
    fromTime: form.fromTime,
    toDate: form.toDate,
    toTime: form.toTime,
  }
}
