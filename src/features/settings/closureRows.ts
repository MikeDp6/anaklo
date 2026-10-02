import { z } from 'zod/mini'
import { findOverlaps, HOUR_MINUTE } from '@fn-shared/hours.ts'
import { addLocalDays, parseLocalDate, weekdayOf, type LocalDate } from '@/shared/lib/dates'
import type { ExceptionKind, NewException } from './schema'

/** Most dates one closure covers (contract 1.6 D11), most intervals of a special day, note. */
export const MAX_CLOSURE_DATES = 62
export const MAX_SPECIAL_INTERVALS = 4
export const MAX_NOTE_LENGTH = 200
/** The intervals a shop-wide «Ειδικό ωράριο» starts with (D11). */
export const SHOP_DEFAULT_INTERVAL = { start: '09:00', end: '17:00' } as const

/** Messages are i18n keys of the `pro` namespace (with their parameters in `CLOSURE_ERROR_PARAMS`). */
export const CLOSURE_ERRORS = {
  dateRequired: 'closures.errors.dateRequired',
  fromPast: 'closures.errors.fromPast',
  toBeforeFrom: 'closures.errors.toBeforeFrom',
  tooManyDays: 'closures.errors.tooManyDays',
  intervalsRequired: 'closures.errors.intervalsRequired',
  intervalsTooMany: 'closures.errors.intervalsTooMany',
  intervalsOverlap: 'closures.errors.intervalsOverlap',
  timeRequired: 'form.errors.required',
  endBeforeStart: 'form.errors.endBeforeStart',
  noteTooLong: 'closures.errors.noteTooLong',
} as const

export type ClosureErrorKey = (typeof CLOSURE_ERRORS)[keyof typeof CLOSURE_ERRORS]

export const CLOSURE_ERROR_PARAMS: Partial<Record<ClosureErrorKey, { max: number }>> = {
  [CLOSURE_ERRORS.tooManyDays]: { max: MAX_CLOSURE_DATES },
  [CLOSURE_ERRORS.intervalsTooMany]: { max: MAX_SPECIAL_INTERVALS },
  [CLOSURE_ERRORS.noteTooLong]: { max: MAX_NOTE_LENGTH },
}

/**
 * The form values. `scope`: '' = the whole shop, else a staff id (the value of the «Για» select).
 */
export interface ClosureFormValues {
  scope: string
  kind: ExceptionKind
  from: string
  to: string
  intervals: { start: string; end: string }[]
  note: string
}

/**
 * The intervals «Ειδικό ωράριο» starts with (contract 1.6 D11): the staff member's weekly hours
 * of the first date, or 09:00–17:00 for the shop, a day off or hours not loaded.
 */
export function prefillIntervals(
  weekRows: readonly { weekday: number; startTime: string; endTime: string }[] | null,
  date: string,
): { start: string; end: string }[] {
  if (weekRows && isDate(date)) {
    const weekday = weekdayOf(date)
    const day = weekRows
      .filter((row) => row.weekday === weekday)
      .filter((row) => HOUR_MINUTE.test(row.startTime) && HOUR_MINUTE.test(row.endTime))
      .map((row) => ({ start: row.startTime, end: row.endTime }))
      .sort((a, b) => (a.start < b.start ? -1 : 1))
      .slice(0, MAX_SPECIAL_INTERVALS)
    if (day.length > 0) return day
  }
  return [{ ...SHOP_DEFAULT_INTERVAL }]
}

function isDate(value: string): boolean {
  try {
    parseLocalDate(value)
    return true
  } catch {
    return false
  }
}

const DAY_MS = 86_400_000

/** How many dates `[from, to]` covers (both inclusive), from the calendar, never instants. */
export function dateCount(from: LocalDate, to: LocalDate): number {
  const [fy, fm, fd] = parseLocalDate(from)
  const [ty, tm, td] = parseLocalDate(to)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS) + 1
}

/**
 * `ClosureSheet`'s form (contract 1.6 §4.6), for React Hook Form via `zodResolver`. `today` is the
 * business-local date: a closure starts today or later. The database re-checks everything
 * (exclusion `schedule_exceptions_no_overlap` → `23P01`, shape and note CHECKs).
 */
export function closureFormSchema(today: LocalDate) {
  return z
    .object({
      scope: z.string(),
      kind: z.enum(['closed', 'open']),
      from: z.string(),
      to: z.string(),
      intervals: z.array(z.object({ start: z.string(), end: z.string() })),
      note: z.string(),
    })
    .check(
      z.superRefine((form, ctx) => {
        const issue = (path: (string | number)[], message: ClosureErrorKey) =>
          ctx.addIssue({ code: 'custom', path, message, input: form })
        const fromOk = isDate(form.from)
        const toOk = isDate(form.to)
        if (!fromOk) issue(['from'], CLOSURE_ERRORS.dateRequired)
        else if (form.from < today) issue(['from'], CLOSURE_ERRORS.fromPast)
        if (!toOk) issue(['to'], CLOSURE_ERRORS.dateRequired)
        else if (fromOk && form.to < form.from) issue(['to'], CLOSURE_ERRORS.toBeforeFrom)
        else if (fromOk && dateCount(form.from, form.to) > MAX_CLOSURE_DATES) {
          issue(['to'], CLOSURE_ERRORS.tooManyDays)
        }
        if (form.scope === '' && form.note.trim().length > MAX_NOTE_LENGTH) {
          issue(['note'], CLOSURE_ERRORS.noteTooLong)
        }
        if (form.kind !== 'open') return
        if (form.intervals.length === 0) {
          issue(['intervals'], CLOSURE_ERRORS.intervalsRequired)
          return
        }
        if (form.intervals.length > MAX_SPECIAL_INTERVALS) {
          issue(['intervals'], CLOSURE_ERRORS.intervalsTooMany)
        }
        const valid: { start: string; end: string }[] = []
        form.intervals.forEach((interval, index) => {
          if (!HOUR_MINUTE.test(interval.start)) {
            issue(['intervals', index, 'start'], CLOSURE_ERRORS.timeRequired)
          } else if (!HOUR_MINUTE.test(interval.end)) {
            issue(['intervals', index, 'end'], CLOSURE_ERRORS.timeRequired)
          } else if (interval.end <= interval.start) {
            issue(['intervals', index, 'end'], CLOSURE_ERRORS.endBeforeStart)
          } else {
            valid.push(interval)
          }
        })
        if (valid.length === form.intervals.length && findOverlaps(valid).length > 0) {
          issue(['intervals'], CLOSURE_ERRORS.intervalsOverlap)
        }
      }),
    )
}

/** Every date of `[from, to]`, in order. */
export function datesOf(from: LocalDate, to: LocalDate): LocalDate[] {
  const dates: LocalDate[] = []
  for (let date = from; date <= to; date = addLocalDays(date, 1)) dates.push(date)
  return dates
}

/**
 * The rows `addExceptions` inserts (contract 1.6 §4.6): one per date for «Κλειστό», one per date ×
 * interval for «Ειδικό ωράριο»; the note only on shop-wide rows (CHECK
 * `schedule_exceptions_note_shop_only`, D4), trimmed, empty = none. `newId` gives each row its
 * client-generated id (the retry of the same attempt resends the same rows).
 */
export function toExceptionRows(form: ClosureFormValues, newId: () => string): NewException[] {
  const staffId = form.scope === '' ? null : form.scope
  const trimmed = form.note.trim()
  const note = staffId === null && trimmed !== '' ? trimmed : null
  const intervals = [...form.intervals].sort((a, b) => (a.start < b.start ? -1 : 1))
  return datesOf(form.from, form.to).flatMap((localDate): NewException[] =>
    form.kind === 'closed'
      ? [{ id: newId(), staffId, localDate, kind: 'closed', startTime: null, endTime: null, note }]
      : intervals.map((interval) => ({
          id: newId(),
          staffId,
          localDate,
          kind: 'open',
          startTime: interval.start,
          endTime: interval.end,
          note,
        })),
  )
}
