import { useEffect, useState } from 'react'
import {
  addLocalDays,
  localDateTimeToInstant,
  toLocalDate,
  type LocalDate,
} from '@/shared/lib/dates'

/** setTimeout's largest delay; a longer wait (never needed for one day) would fire at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * The business-local date of today (contract 1.4 §3.3). Recomputed when the app comes back to the
 * foreground and right after the next local midnight, so the day and «Σήμερα» keys roll over on
 * their own.
 */
export function useBusinessToday(timeZone: string): LocalDate {
  const [today, setToday] = useState(() => toLocalDate(new Date(), timeZone))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      const now = new Date()
      const date = toLocalDate(now, timeZone)
      setToday(date)
      clearTimeout(timer)
      const midnight = localDateTimeToInstant(addLocalDays(date, 1), '00:00', timeZone)
      timer = setTimeout(
        refresh,
        Math.min(MAX_TIMEOUT_MS, midnight.getTime() - now.getTime() + 500),
      )
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    // Asynchronously, so a new zone is picked up without a state update inside the effect body.
    timer = setTimeout(refresh, 0)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [timeZone])

  return today
}
