import {
  localDateTimeToInstant,
  toLocalTime,
  type LocalDate,
  type LocalTime,
} from '@/shared/lib/dates'

/**
 * Layout of the day view (contract 1.4 §4, no calendar library). Positions are REAL minutes
 * elapsed since the local midnight (`dayStart` of `busy_calendar`), so a 23-hour or 25-hour day
 * (DST) is drawn as it happened: 03:00 twice on the autumn day, no 03:00 on the spring day.
 * Labels come from `dates.ts` in the business zone. Pure: the component multiplies by px.
 */

type InstantLike = string | Date

const MINUTE_MS = 60_000
const HOUR_MIN = 60

function ms(value: InstantLike): number {
  return typeof value === 'string' ? Date.parse(value) : value.getTime()
}

/** Real minutes from `from` to `to` (negative when `to` is earlier). */
export function minutesBetween(from: InstantLike, to: InstantLike): number {
  return (ms(to) - ms(from)) / MINUTE_MS
}

/** 1380, 1440 or 1500 in a zone with a one-hour DST shift. */
export function dayLengthMinutes(dayStart: InstantLike, dayEnd: InstantLike): number {
  return minutesBetween(dayStart, dayEnd)
}

/** The drawn part of the day, in minutes since `dayStart`. */
export interface DayRange {
  readonly fromMin: number
  readonly toMin: number
}

export interface RangeInput {
  readonly localDate: LocalDate
  readonly timeZone: string
  readonly dayStart: InstantLike
  readonly dayEnd: InstantLike
  /** Every instant that must be visible: window edges, appointment edges, «now». */
  readonly instants: readonly InstantLike[]
  /** Shown when nothing else is (a closed day): local wall-clock times. */
  readonly fallback?: { readonly from: LocalTime; readonly to: LocalTime }
}

/**
 * Whole hours around everything that must show. Hour boundaries stay aligned with the local
 * clock across a one-hour DST shift, because `dayStart` is a local midnight.
 */
export function visibleRange({
  localDate,
  timeZone,
  dayStart,
  dayEnd,
  instants,
  fallback = { from: '08:00', to: '20:00' },
}: RangeInput): DayRange {
  const length = dayLengthMinutes(dayStart, dayEnd)
  const clamp = (minute: number) => Math.min(length, Math.max(0, minute))
  let points = instants.map((instant) => clamp(minutesBetween(dayStart, instant)))
  if (points.length === 0) {
    points = [fallback.from, fallback.to].map((time) =>
      clamp(minutesBetween(dayStart, localDateTimeToInstant(localDate, time, timeZone))),
    )
  }
  const fromMin = Math.floor(Math.min(...points) / HOUR_MIN) * HOUR_MIN
  const toMin = Math.min(length, Math.ceil(Math.max(...points) / HOUR_MIN) * HOUR_MIN)
  return toMin > fromMin ? { fromMin, toMin } : { fromMin, toMin: Math.min(length, fromMin + 60) }
}

export interface HourMark {
  /** Minutes since `dayStart`. */
  readonly minute: number
  /** Local wall-clock time, e.g. «03:00» (twice on the autumn DST day). */
  readonly label: LocalTime
}

/** One mark per elapsed hour of the range, labelled with the local time it shows. */
export function hourMarks(dayStart: InstantLike, timeZone: string, range: DayRange): HourMark[] {
  const start = ms(dayStart)
  const marks: HourMark[] = []
  for (let minute = range.fromMin; minute <= range.toMin; minute += HOUR_MIN) {
    marks.push({ minute, label: toLocalTime(new Date(start + minute * MINUTE_MS), timeZone) })
  }
  return marks
}

export interface TimedItem {
  readonly id: string
  readonly startsAt: InstantLike
  readonly endsAt: InstantLike
}

export interface PlacedItem<T extends TimedItem> {
  readonly item: T
  /** Minutes from the top of the range. */
  readonly top: number
  /** Minutes, at least `minMinutes`. */
  readonly height: number
  /** 0-based lane inside its overlap group, and how many lanes the group has. */
  readonly lane: number
  readonly lanes: number
}

/**
 * Places the items of one column: overlapping items share the width in lanes (greedy, first free
 * lane), items that only touch (end = next start) do not overlap. Items outside the range are
 * dropped; those crossing an edge are clipped to it. A very short item is drawn `minMinutes`
 * tall, and that drawn height is what counts as overlapping, so no two boxes ever cover each
 * other.
 */
export function layoutColumn<T extends TimedItem>(
  items: readonly T[],
  dayStart: InstantLike,
  range: DayRange,
  minMinutes = 10,
): PlacedItem<T>[] {
  const spans = items
    .map((item) => ({
      item,
      rawStart: minutesBetween(dayStart, item.startsAt),
      rawEnd: minutesBetween(dayStart, item.endsAt),
    }))
    .filter(
      ({ rawStart, rawEnd }) =>
        rawStart < range.toMin && (rawEnd > range.fromMin || rawStart >= range.fromMin),
    )
    .map(({ item, rawStart, rawEnd }) => {
      const start = Math.max(range.fromMin, rawStart)
      const end = Math.max(start + minMinutes, Math.min(range.toMin, rawEnd))
      return { item, start, end }
    })
    .sort((a, b) => a.start - b.start || b.end - a.end || a.item.id.localeCompare(b.item.id))

  const placed: PlacedItem<T>[] = []
  let group: { span: (typeof spans)[number]; lane: number }[] = []
  let laneEnds: number[] = []
  let groupEnd = -Infinity

  const closeGroup = () => {
    for (const { span, lane } of group) {
      placed.push({
        item: span.item,
        top: span.start - range.fromMin,
        height: span.end - span.start,
        lane,
        lanes: laneEnds.length,
      })
    }
    group = []
    laneEnds = []
    groupEnd = -Infinity
  }

  for (const span of spans) {
    if (span.start >= groupEnd) closeGroup()
    let lane = laneEnds.findIndex((end) => end <= span.start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(span.end)
    } else {
      laneEnds[lane] = span.end
    }
    group.push({ span, lane })
    groupEnd = Math.max(groupEnd, span.end)
  }
  closeGroup()
  return placed
}

/** Where «now» sits in the range (minutes from its top), or null outside it. */
export function nowOffset(now: Date, dayStart: InstantLike, range: DayRange): number | null {
  const minute = minutesBetween(dayStart, now)
  return minute >= range.fromMin && minute <= range.toMin ? minute - range.fromMin : null
}
