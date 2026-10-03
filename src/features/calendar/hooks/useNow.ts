import { useEffect, useState } from 'react'

/** The current time, refreshed every `intervalMs` (the «now» line, what has started). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/**
 * The later of the ticking clock and the moment the data on screen was fetched. An item that
 * started between two ticks (a walk-in just added) is already «Τώρα» once its list refetched,
 * instead of showing its own start time until the next tick.
 */
export function clockAtLeast(now: Date, fetchedAtMs: number): Date {
  return fetchedAtMs > now.getTime() ? new Date(fetchedAtMs) : now
}
