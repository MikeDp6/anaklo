/** A unit of a minute value as the policy screen spells it (`policy.duration.<unit>`, plurals). */
export type DurationUnit = 'days' | 'hours' | 'minutes'

export interface DurationPart {
  readonly unit: DurationUnit
  readonly count: number
}

const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 1440

/**
 * A number of minutes in the largest whole units, zero units left out (contract 1.6 §4.8):
 * 90 → 1 hour 30 minutes, 1440 → 1 day, 10080 → 7 days, 0 → [] («Καμία»).
 */
export function durationParts(totalMinutes: number): DurationPart[] {
  const minutes = Math.max(0, Math.trunc(totalMinutes))
  const days = Math.floor(minutes / MINUTES_PER_DAY)
  const hours = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR)
  const rest = minutes % MINUTES_PER_HOUR
  const parts: DurationPart[] = [
    { unit: 'days', count: days },
    { unit: 'hours', count: hours },
    { unit: 'minutes', count: rest },
  ]
  return parts.filter((part) => part.count > 0)
}
