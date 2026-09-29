import { useEffect, useState } from 'react'
import {
  browserStorage,
  decideTodayCountUp,
  readTodayCountUp,
  writeTodayCountUp,
  type TodayCountUpDecision,
} from '../todayCountUp'

/**
 * E6 decision of «Σήμερα» (contract 1.4 §4): made once, when the component that shows the
 * numbers mounts, i.e. when `today_summary` first arrived (it is not rendered under the
 * skeleton) and again only when it is remounted for a new local date (`key={localDate}`).
 * Refetches never decide again. The marker is written only when the count runs.
 */
export function useTodayCountUp(businessId: string, timeZone: string): boolean {
  const [decision] = useState<TodayCountUpDecision>(() =>
    decideTodayCountUp({
      now: new Date(),
      timeZone,
      lastShown: readTodayCountUp(browserStorage(), businessId),
    }),
  )

  useEffect(() => {
    if (decision.countUp) writeTodayCountUp(browserStorage(), businessId, decision.localDate)
  }, [decision, businessId])

  return decision.countUp
}
