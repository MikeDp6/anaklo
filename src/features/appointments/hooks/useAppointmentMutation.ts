import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { invalidateAppointmentChange } from '@/features/calendar/invalidate'
import { failureOf, type RpcFailureInfo } from '@/shared/lib/rpcError'

/** After these the lists are stale: another device changed the day (contract 1.4 §3.5). */
const STALE_DAY_CODES: ReadonlySet<string> = new Set(['AN001', 'AN020', 'AN021'])

export interface AppointmentMutation<V, R> {
  readonly submit: (variables: V) => void
  /** The identical variables again (same idempotency key): the way out of `locked`. */
  readonly retry: () => void
  readonly reset: () => void
  readonly pending: boolean
  /** Set only once the server answered (rule 14: never before). */
  readonly result: R | null
  readonly failure: RpcFailureInfo | null
  /**
   * The outcome of the last attempt is unknown (offline, timeout): the form stays locked, also
   * while a retry runs, until the server answers (contract 1.4 §0.15).
   */
  readonly locked: boolean
  readonly variables: V | undefined
  /** Reloads the day(s) of the last attempt: «Κλείσιμο» after an unknown outcome shows the truth. */
  readonly refreshInvolved: () => void
}

/**
 * A write on an appointment. No optimistic cache writes: while pending the sheet shows the
 * pending label; the success state comes from `result`, i.e. from the server's answer. On
 * success (and on the codes that mean the day changed elsewhere) the day(s) involved, «Σήμερα»
 * and the free times are invalidated through the one path of `invalidate.ts`.
 */
export function useAppointmentMutation<V, R>({
  businessId,
  timeZone,
  mutationFn,
  instantsOf,
  onSuccess,
  onFailure,
}: {
  businessId: string
  timeZone: string
  mutationFn: (variables: V) => Promise<R>
  /** Every start involved, before and after (so both days refresh). */
  instantsOf: (variables: V, result: R | undefined) => readonly string[]
  /**
   * For the component that sent the write (e.g. close its sheet). Runs only while it is still
   * mounted: a write that answers after its sheet closed must never act on whatever sheet is open
   * by then. The cache refresh runs in any case.
   */
  onSuccess?: (result: R, variables: V) => void
  /**
   * The classified failure of a call, for its component (e.g. the conflict resolver refetches the
   * free colleagues after AN001). Like `onSuccess`, only while that component is mounted.
   */
  onFailure?: (failure: RpcFailureInfo, variables: V) => void
}): AppointmentMutation<V, R> {
  const queryClient = useQueryClient()
  const [unknownOutcome, setUnknownOutcome] = useState(false)
  const invalidate = (instants: readonly string[]) =>
    void invalidateAppointmentChange(queryClient, businessId, timeZone, { instants })

  const mutation = useMutation({
    mutationFn,
    onSuccess: (result, variables) => {
      setUnknownOutcome(false)
      invalidate(instantsOf(variables, result))
    },
    onError: (error, variables) => {
      const failure = failureOf(error)
      setUnknownOutcome(failure.kind === 'offline')
      if (failure.kind === 'domain' && STALE_DAY_CODES.has(failure.code)) {
        invalidate(instantsOf(variables, undefined))
      }
    },
  })

  const { variables, mutate } = mutation
  // Per-call callbacks: TanStack Query skips them once this component unmounted, unlike the
  // useMutation options above, which run for every mutation that settles.
  const send = (next: V) =>
    mutate(next, {
      ...(onSuccess ? { onSuccess } : {}),
      ...(onFailure
        ? { onError: (error: Error, sent: V) => onFailure(failureOf(error), sent) }
        : {}),
    })
  return {
    submit: send,
    retry: () => {
      if (variables !== undefined) send(variables)
    },
    reset: () => {
      setUnknownOutcome(false)
      mutation.reset()
    },
    pending: mutation.isPending,
    result: mutation.data ?? null,
    failure: mutation.error ? failureOf(mutation.error) : null,
    locked: unknownOutcome,
    variables,
    refreshInvolved: () => {
      if (variables !== undefined) invalidate(instantsOf(variables, mutation.data))
    },
  }
}
