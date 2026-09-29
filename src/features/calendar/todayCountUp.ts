import { toLocalDate, type LocalDate } from '@/shared/lib/dates'

/**
 * E6 on «Σήμερα» (contract 1.4 §4, MOTION.md E6): the numbers count up only on the first load of
 * the business-local day on this device, never on the 60″ or focus refetches. The last day shown
 * is kept per business in localStorage; storage that is missing or throws only means the count
 * runs again (accepted).
 */

export const TODAY_COUNT_UP_KEY_PREFIX = 'anaklo:pro:today-count-up:'

export interface TodayCountUpInput {
  readonly now: Date
  /** businesses.timezone */
  readonly timeZone: string
  /** Raw stored value; anything that is not this local date counts as "not shown". */
  readonly lastShown: string | null
}

export interface TodayCountUpDecision {
  readonly localDate: LocalDate
  readonly countUp: boolean
}

/** Pure. */
export function decideTodayCountUp({
  now,
  timeZone,
  lastShown,
}: TodayCountUpInput): TodayCountUpDecision {
  const localDate = toLocalDate(now, timeZone)
  return { localDate, countUp: lastShown !== localDate }
}

export function readTodayCountUp(
  storage: Pick<Storage, 'getItem'> | undefined,
  businessId: string,
): string | null {
  try {
    return storage?.getItem(TODAY_COUNT_UP_KEY_PREFIX + businessId) ?? null
  } catch {
    return null
  }
}

export function writeTodayCountUp(
  storage: Pick<Storage, 'setItem'> | undefined,
  businessId: string,
  localDate: LocalDate,
): void {
  try {
    storage?.setItem(TODAY_COUNT_UP_KEY_PREFIX + businessId, localDate)
  } catch {
    // Private mode or a full quota: the count simply runs again next time.
  }
}

/** `window.localStorage`, or undefined where even reading the property throws. */
export function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}
