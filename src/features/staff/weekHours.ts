import { z } from 'zod/mini'
import {
  findOverlaps,
  HOUR_MINUTE,
  minutesOf,
  WEEKDAY_KEYS,
  WEEKDAYS,
  type WeekdayKey,
} from '@fn-shared/hours.ts'
import type { WeekRow } from './schema'

/**
 * The week-hours editor (contract 1.6 §4.5): one list of intervals per weekday, Monday first.
 * The checks here are UI feedback only; `replace_week_hours` and the `working_hours_no_overlap`
 * exclusion decide (an overlap the form missed comes back as `23P01`).
 */

export const MAX_INTERVALS_PER_DAY = 4
/** Prefill of «Προσθήκη ωραρίου» on a closed day. */
export const DEFAULT_INTERVAL = { start: '09:00', end: '17:00' } as const

/** An end may be '24:00' (stored by the database, never produced by a time input). */
const END_OF_DAY = '24:00'

const IntervalForm = z.object({ start: z.string(), end: z.string() })
const DayForm = z.array(IntervalForm)

export type IntervalValues = z.infer<typeof IntervalForm>

/** i18n keys (`pro`) of the issues. */
export const WEEK_HOURS_ERRORS = {
  time: 'hours.errors.time',
  endBeforeStart: 'form.errors.endBeforeStart',
  overlap: 'hours.errors.overlap',
  tooMany: 'hours.errors.tooMany',
} as const

function validStart(time: string): boolean {
  return HOUR_MINUTE.test(time)
}

function validEnd(time: string): boolean {
  return HOUR_MINUTE.test(time) || time === END_OF_DAY
}

export const WeekHoursFormSchema = z
  .object({
    days: z.object({
      mon: DayForm,
      tue: DayForm,
      wed: DayForm,
      thu: DayForm,
      fri: DayForm,
      sat: DayForm,
      sun: DayForm,
    }),
  })
  .check(
    z.superRefine((form, ctx) => {
      for (const day of WEEKDAY_KEYS) {
        const intervals = form.days[day]
        const issue = (path: (string | number)[], message: string) =>
          ctx.addIssue({ code: 'custom', message, path: ['days', day, ...path] })
        if (intervals.length > MAX_INTERVALS_PER_DAY) issue([], WEEK_HOURS_ERRORS.tooMany)
        let wellFormed = true
        intervals.forEach((interval, index) => {
          if (!validStart(interval.start)) {
            issue([index, 'start'], WEEK_HOURS_ERRORS.time)
            wellFormed = false
          }
          if (!validEnd(interval.end)) {
            issue([index, 'end'], WEEK_HOURS_ERRORS.time)
            wellFormed = false
          } else if (validStart(interval.start)) {
            if (minutesOf(interval.end) <= minutesOf(interval.start)) {
              issue([index, 'end'], WEEK_HOURS_ERRORS.endBeforeStart)
              wellFormed = false
            }
          }
        })
        // Overlaps only between well-formed intervals (back-to-back is fine, as in the database).
        if (!wellFormed) continue
        for (const [, later] of findOverlaps(intervals)) {
          issue([later, 'start'], WEEK_HOURS_ERRORS.overlap)
        }
      }
    }),
  )

export type WeekForm = z.infer<typeof WeekHoursFormSchema>

/** `weekday` (0 = Sunday) → its key. */
export function weekdayKey(weekday: number): WeekdayKey | null {
  return WEEKDAY_KEYS.find((key) => WEEKDAYS[key] === weekday) ?? null
}

function emptyDays(): WeekForm['days'] {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }
}

function byStart(a: IntervalValues, b: IntervalValues): number {
  return a.start < b.start ? -1 : a.start > b.start ? 1 : 0
}

/** Stored rows → the form (each day's intervals by start). */
export function toWeekForm(rows: readonly WeekRow[]): WeekForm {
  const days = emptyDays()
  for (const row of rows) {
    const key = weekdayKey(row.weekday)
    if (key) days[key].push({ start: row.startTime, end: row.endTime })
  }
  for (const key of WEEKDAY_KEYS) days[key].sort(byStart)
  return { days }
}

/** The form → `replace_week_hours` rows, sorted by weekday (0 = Sunday first), then start. */
export function toWeekRows(form: WeekForm): WeekRow[] {
  return WEEKDAY_KEYS.flatMap((key) =>
    form.days[key].map((interval) => ({
      weekday: WEEKDAYS[key],
      startTime: interval.start,
      endTime: interval.end,
    })),
  ).sort(
    (a, b) =>
      a.weekday - b.weekday ||
      byStart({ start: a.startTime, end: a.endTime }, { start: b.startTime, end: b.endTime }),
  )
}

/** «Αντιγραφή σε όλες τις μέρες»: `day`'s intervals on all seven days, closed ones too (D12). */
export function copyDayToAll(form: WeekForm, day: WeekdayKey): WeekForm {
  const source = form.days[day]
  const days = emptyDays()
  for (const key of WEEKDAY_KEYS) days[key] = source.map((interval) => ({ ...interval }))
  return { days }
}

/** The next interval of a day: after the last one when there is room, else the default. */
export function nextInterval(intervals: readonly IntervalValues[]): IntervalValues {
  const last = intervals.at(-1)
  if (!last || !HOUR_MINUTE.test(last.end)) return { ...DEFAULT_INTERVAL }
  const start = minutesOf(last.end)
  const end = Math.min(start + 4 * 60, 23 * 60 + 59)
  if (end <= start) return { ...DEFAULT_INTERVAL }
  return { start: last.end, end: hm(end) }
}

function hm(minutes: number): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}
