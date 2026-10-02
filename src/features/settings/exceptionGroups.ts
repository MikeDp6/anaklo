import { addLocalDays, type LocalDate } from '@/shared/lib/dates'
import type { ExceptionKind, Hm, ScheduleException } from './schema'

export interface Interval {
  readonly start: Hm
  readonly end: Hm
}

/** One item of `ClosuresList`: consecutive dates with the same scope, kind, hours and note. */
export interface ExceptionGroup {
  readonly key: string
  /** null = the whole shop. */
  readonly staffId: string | null
  readonly kind: ExceptionKind
  readonly from: LocalDate
  /** Inclusive; equal to `from` for a single date. */
  readonly to: LocalDate
  readonly intervals: readonly Interval[]
  readonly note: string | null
  /** Every row of the group: «Διαγραφή» deletes them in one call. */
  readonly ids: readonly string[]
}

interface Day {
  readonly staffId: string | null
  readonly date: LocalDate
  readonly kind: ExceptionKind
  readonly intervals: Interval[]
  readonly notes: string[]
  readonly ids: string[]
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Shop first, then staff by id (a stable order; the screen shows names). */
function compareScope(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return compareText(a, b)
}

function signature(day: Day): string {
  const hours = day.intervals.map((interval) => `${interval.start}-${interval.end}`).join(',')
  return `${day.kind}|${hours}|${day.notes.join('\u0000')}`
}

/** The rows of each scope and date, gathered into one day (several `open` intervals, or `closed`). */
function toDays(rows: readonly ScheduleException[]): Day[] {
  const days = new Map<string, Day>()
  for (const row of rows) {
    const key = `${row.staffId ?? ''}|${row.localDate}`
    let day = days.get(key)
    if (!day) {
      day = {
        staffId: row.staffId,
        date: row.localDate,
        kind: row.kind,
        intervals: [],
        notes: [],
        ids: [],
      }
      days.set(key, day)
    }
    day.ids.push(row.id)
    if (row.startTime !== null && row.endTime !== null) {
      day.intervals.push({ start: row.startTime, end: row.endTime })
    }
    if (row.note !== null && !day.notes.includes(row.note)) day.notes.push(row.note)
  }
  for (const day of days.values()) {
    day.intervals.sort((a, b) => compareText(a.start, b.start))
  }
  return [...days.values()]
}

/**
 * Groups exception rows for the list (contract 1.6 §4.6): consecutive dates with the same scope,
 * kind, interval set and note form one item. Ordered by first date, the shop before staff.
 */
export function groupExceptions(rows: readonly ScheduleException[]): ExceptionGroup[] {
  const days = toDays(rows).sort(
    (a, b) => compareScope(a.staffId, b.staffId) || compareText(a.date, b.date),
  )
  const groups: (ExceptionGroup & { signature: string })[] = []
  for (const day of days) {
    const last = groups.at(-1)
    const daySignature = signature(day)
    if (
      last &&
      last.staffId === day.staffId &&
      last.signature === daySignature &&
      addLocalDays(last.to, 1) === day.date
    ) {
      groups[groups.length - 1] = { ...last, to: day.date, ids: [...last.ids, ...day.ids] }
      continue
    }
    groups.push({
      key: day.ids[0] ?? `${day.staffId ?? 'shop'}-${day.date}`,
      staffId: day.staffId,
      kind: day.kind,
      from: day.date,
      to: day.date,
      intervals: day.intervals,
      note: day.notes.length > 0 ? day.notes.join(' · ') : null,
      ids: day.ids,
      signature: daySignature,
    })
  }
  return groups
    .sort((a, b) => compareText(a.from, b.from) || compareScope(a.staffId, b.staffId))
    .map(({ signature: _signature, ...group }) => group)
}
