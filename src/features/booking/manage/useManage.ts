import { useCallback, useEffect, useRef, useState } from 'react'
import type { ManageViewResponse } from '@fn-shared/booking-schemas.ts'
import { apiErrorCode } from '@/shared/lib/publicApi'
import { manageCancel, manageReschedule, manageView } from './manageApi'

export type ManageMode = 'view' | 'confirm-cancel' | 'reschedule' | 'cancelled' | 'moved'

type Load =
  | { status: 'loading' }
  | { status: 'ready'; view: ManageViewResponse }
  | { status: 'error'; code: string }

/**
 * The manage link: view (changes nothing), cancel, reschedule. Results show only after the
 * server answered (rule 14); one action at a time.
 */
export function useManage(token: string) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [mode, setMode] = useState<ManageMode>('view')
  const [pending, setPending] = useState<'cancel' | 'reschedule' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    manageView(token, controller.signal).then(
      (view) => setLoad({ status: 'ready', view }),
      (failure: unknown) => {
        if (!controller.signal.aborted) setLoad({ status: 'error', code: apiErrorCode(failure) })
      },
    )
    return () => controller.abort()
  }, [token, attempt])

  const retry = useCallback(() => {
    setLoad({ status: 'loading' })
    setAttempt((value) => value + 1)
  }, [])

  /** Resolves with the error code of a failed action (also shown as `error`), null otherwise. */
  const run = useCallback(
    async (kind: 'cancel' | 'reschedule', action: () => Promise<void>): Promise<string | null> => {
      if (busy.current) return null
      busy.current = true
      setPending(kind)
      setError(null)
      try {
        await action()
        return null
      } catch (failure) {
        const code = apiErrorCode(failure)
        setError(code)
        return code
      } finally {
        busy.current = false
        setPending(null)
      }
    },
    [],
  )

  const cancel = () =>
    run('cancel', async () => {
      await manageCancel(token)
      setMode('cancelled')
    })

  const reschedule = (startsAt: string) =>
    run('reschedule', async () => {
      const moved = await manageReschedule(token, startsAt)
      // Read the view again: the change window follows the new time.
      const view = await manageView(token).catch(() => null)
      setLoad((current) => {
        if (view) return { status: 'ready', view }
        if (current.status !== 'ready') return current
        const appointment = { ...current.view.appointment, ...moved.appointment }
        return { status: 'ready', view: { ...current.view, appointment } }
      })
      setMode('moved')
    })

  const show = (next: ManageMode) => {
    setError(null)
    setMode(next)
  }

  return { load, retry, mode, show, pending, error, cancel, reschedule }
}
