import { useCallback, useEffect, useState } from 'react'
import { fetchSlots, forgetSlots, type SlotQuery } from '../api'
import type { Slot } from '../schema'

export type SlotsState =
  | { status: 'idle' | 'loading' | 'error'; slots: readonly Slot[] }
  | { status: 'ready'; slots: readonly Slot[] }

interface Result {
  key: string
  attempt: number
  slots: Slot[] | null
}

const NO_SLOTS: readonly Slot[] = []

/** Free starts for a date range; `null` = nothing to ask yet. Stale answers are ignored. */
export function useSlots(query: SlotQuery | null): SlotsState & { retry: () => void } {
  const [result, setResult] = useState<Result | null>(null)
  const [attempt, setAttempt] = useState(0)
  const { slug, serviceId, staffId, from, to } = query ?? {}
  const key = query ? [slug, serviceId, staffId, from, to].join('|') : null

  useEffect(() => {
    if (key === null || !slug || !serviceId || !from || !to) return
    let live = true
    fetchSlots({ slug, serviceId, staffId: staffId ?? null, from, to }).then(
      (slots) => live && setResult({ key, attempt, slots }),
      () => live && setResult({ key, attempt, slots: null }),
    )
    return () => {
      live = false
    }
  }, [key, attempt, slug, serviceId, staffId, from, to])

  const retry = useCallback(() => {
    forgetSlots()
    setAttempt((value) => value + 1)
  }, [])

  if (key === null) return { status: 'idle', slots: NO_SLOTS, retry }
  if (!result || result.key !== key || result.attempt !== attempt) {
    return { status: 'loading', slots: NO_SLOTS, retry }
  }
  if (result.slots === null) return { status: 'error', slots: NO_SLOTS, retry }
  return { status: 'ready', slots: result.slots, retry }
}
