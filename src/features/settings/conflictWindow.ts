import {
  addLocalDays,
  localDateTimeToInstant,
  parseLocalDate,
  type LocalDate,
} from '@/shared/lib/dates'
import type { ConflictsQuery } from './schema'

/** The query string of `/settings/conflicts` (contract 1.6 §4.1): all optional. */
export interface ConflictParams {
  readonly staff: string | null
  /** Business-local dates, both inclusive. */
  readonly from: LocalDate | null
  readonly to: LocalDate | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The longest window `schedule_conflicts` answers: 366 days = 8784 hours, whatever the zone (a
 * longer one is AN002). Also its default horizon from now, and the longest time off the form
 * accepts (so a saved time off always has its conflicts listed in full).
 */
export const CONFLICT_HORIZON_MS = 366 * 24 * 60 * 60 * 1000

/**
 * A window no longer than the server answers: `to` at most `CONFLICT_HORIZON_MS` after its start,
 * which is then sent explicitly (a server-side «now» a moment later must not make it longer).
 * Shorter windows and the server default (`to` null) stay as they are.
 */
function withinHorizon(query: ConflictsQuery, now: number): ConflictsQuery {
  if (query.to === null) return query
  const from = query.from === null ? now : Date.parse(query.from)
  if (Date.parse(query.to) - from <= CONFLICT_HORIZON_MS) return query
  return {
    staffId: query.staffId,
    from: new Date(from).toISOString(),
    to: new Date(from + CONFLICT_HORIZON_MS).toISOString(),
  }
}

function validDate(value: string | null): LocalDate | null {
  if (value === null) return null
  try {
    parseLocalDate(value)
    return value
  } catch {
    return null
  }
}

/** Reads the params; a malformed value counts as absent (the server default applies). */
export function readConflictParams(search: URLSearchParams): ConflictParams {
  const staff = search.get('staff')
  return {
    staff: staff && UUID.test(staff) ? staff : null,
    from: validDate(search.get('from')),
    to: validDate(search.get('to')),
  }
}

/** The link to the conflicts screen for a scope and a date range (null = the default). */
export function conflictsPath(params: Partial<ConflictParams>): string {
  const search = new URLSearchParams()
  if (params.staff) search.set('staff', params.staff)
  if (params.from) search.set('from', params.from)
  if (params.to) search.set('to', params.to)
  const query = search.toString()
  return query ? `/settings/conflicts?${query}` : '/settings/conflicts'
}

/**
 * The instants `schedule_conflicts` is asked for (contract 1.6 §4.9): `from` = the later of now
 * and the start of the `from` date, `to` = the start of the day after the `to` date, both in the
 * business zone; null leaves the server default (from now; 366 days on). A range longer than the
 * server answers (a hand-written link) is cut to 366 days from its start instead of failing.
 */
export function conflictWindow(
  params: ConflictParams,
  now: Date,
  timeZone: string,
): ConflictsQuery {
  const fromStart = params.from ? localDateTimeToInstant(params.from, '00:00', timeZone) : null
  const from = fromStart ? new Date(Math.max(now.getTime(), fromStart.getTime())) : null
  const to = params.to
    ? localDateTimeToInstant(addLocalDays(params.to, 1), '00:00', timeZone)
    : null
  return withinHorizon(
    {
      staffId: params.staff,
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
    },
    now.getTime(),
  )
}

/** The span a closure or a time off covers (instants), and its staff member (null = the shop). */
export interface ConflictSpan {
  readonly staffId: string | null
  readonly from: string
  readonly to: string
}

/**
 * The part of a span still ahead (`from` no earlier than now); null when it is over. At most 366
 * days of it (the form keeps a time off within that, closures are ≤ 62 dates).
 */
export function aheadOf(span: ConflictSpan, now: number): ConflictsQuery | null {
  const from = Math.max(now, Date.parse(span.from))
  if (Date.parse(span.to) <= from) return null
  return withinHorizon(
    { staffId: span.staffId, from: new Date(from).toISOString(), to: span.to },
    now,
  )
}

/** The instants of whole business-local dates `[from 00:00, (to + 1) 00:00)`. */
export function spanOfDates(
  staffId: string | null,
  from: LocalDate,
  to: LocalDate,
  timeZone: string,
): ConflictSpan {
  return {
    staffId,
    from: localDateTimeToInstant(from, '00:00', timeZone).toISOString(),
    to: localDateTimeToInstant(addLocalDays(to, 1), '00:00', timeZone).toISOString(),
  }
}

/** A window that is already over (a past range): nothing can conflict, nothing to ask. */
export function isPastWindow(query: ConflictsQuery, now: Date): boolean {
  if (query.to === null) return false
  const from = query.from === null ? now.getTime() : Date.parse(query.from)
  return Date.parse(query.to) <= from
}
