import { useCallback, useEffect, useState } from 'react'
import type { ManageSlot } from '@fn-shared/booking-schemas.ts'
import type { LocalDate } from '@/shared/lib/localDates'
import { manageSlots } from './manageApi'

export type ManageSlotsState = {
  status: 'loading' | 'error' | 'ready'
  slots: readonly ManageSlot[]
}

interface Result {
  key: string
  attempt: number
  slots: ManageSlot[] | null
}

const NO_SLOTS: readonly ManageSlot[] = []

/**
 * The starts the appointment behind a manage link may move to, for one window of dates (the
 * server lists exactly what `manage_reschedule` accepts). Stale answers are ignored; `refetch`
 * asks again, e.g. after AN001 (the time was taken meanwhile).
 */
export function useManageSlots(
  token: string,
  from: LocalDate,
  to: LocalDate,
): ManageSlotsState & { refetch: () => void } {
  const [result, setResult] = useState<Result | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = `${token}|${from}|${to}`

  useEffect(() => {
    const controller = new AbortController()
    const settle = (slots: ManageSlot[] | null) => {
      if (!controller.signal.aborted) setResult({ key, attempt, slots })
    }
    manageSlots(token, from, to, controller.signal).then(
      (answer) => settle(answer.slots),
      () => settle(null),
    )
    return () => controller.abort()
  }, [token, from, to, key, attempt])

  const refetch = useCallback(() => setAttempt((value) => value + 1), [])

  if (!result || result.key !== key || result.attempt !== attempt) {
    return { status: 'loading', slots: NO_SLOTS, refetch }
  }
  if (result.slots === null) return { status: 'error', slots: NO_SLOTS, refetch }
  return { status: 'ready', slots: result.slots, refetch }
}
