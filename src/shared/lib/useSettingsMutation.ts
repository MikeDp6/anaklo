import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { failureOf, type RpcFailureInfo } from './rpcError'

/**
 * After these the lists on screen may be wrong (another device changed them, or the write was
 * refused for a reason the list does not show): refetch so the screen shows the truth. `gone`:
 * the row was deleted elsewhere, so the list must drop it.
 */
const REFRESH_AFTER: ReadonlySet<RpcFailureInfo['kind']> = new Set(['overlap', 'forbidden', 'gone'])

export interface SettingsMutation<V, R> {
  readonly submit: (variables: V) => void
  /** The identical variables again (same client-generated id): the way out of `locked`. */
  readonly retry: () => void
  /**
   * Back to idle. After an unknown outcome («Κλείσιμο» of a locked form) it also refetches what
   * the write touches, so the screen shows whether it went through.
   */
  readonly reset: () => void
  /** Refetches what the last attempt touches (also when the caller closes without `reset`). */
  readonly refresh: () => void
  readonly pending: boolean
  /** Set only once the server answered (rule 14: never before). */
  readonly result: R | null
  /** The last attempt was answered with success (also when its `result` is empty, e.g. `[]`). */
  readonly succeeded: boolean
  readonly failure: RpcFailureInfo | null
  /**
   * The outcome of the last attempt is unknown (offline, timeout): the form stays locked, also
   * while a retry runs, until the server answers (contract 1.4 §0.15).
   */
  readonly locked: boolean
  readonly variables: V | undefined
}

/**
 * A write of a settings screen (contract 1.6 §3.5), with the semantics of
 * `useAppointmentMutation` (rule 14): no `onMutate`, no cache writes before the answer; the
 * success state comes from `result`; `invalidate` runs after a success (and after `overlap`,
 * `forbidden` or `gone`). New rows carry a client-generated id, so the retry of a write that did commit
 * inserts nothing and still succeeds (an `upsert` that answers `[]` is a success).
 */
export function useSettingsMutation<V, R>(o: {
  mutationFn: (variables: V) => Promise<R>
  invalidate: (queryClient: QueryClient, variables: V, result: R | undefined) => Promise<void>
  /** Per call: runs only while the caller is still mounted (1.4 as built). */
  onSuccess?: (result: R, variables: V) => void
}): SettingsMutation<V, R> {
  const queryClient = useQueryClient()
  const [unknownOutcome, setUnknownOutcome] = useState(false)
  const { invalidate } = o
  const refreshWith = (variables: V, result: R | undefined) =>
    void invalidate(queryClient, variables, result)

  const mutation = useMutation({
    mutationFn: o.mutationFn,
    onSuccess: (result, variables) => {
      setUnknownOutcome(false)
      refreshWith(variables, result)
    },
    onError: (error, variables) => {
      const failure = failureOf(error)
      setUnknownOutcome(failure.kind === 'offline')
      if (REFRESH_AFTER.has(failure.kind)) refreshWith(variables, undefined)
    },
  })

  const { variables, mutate } = mutation
  const onSuccess = o.onSuccess
  // Per-call callbacks: TanStack Query skips them once the caller unmounted.
  const send = (next: V) =>
    mutate(
      next,
      onSuccess ? { onSuccess: (result, variables) => onSuccess(result, variables) } : undefined,
    )
  const refresh = () => {
    if (variables !== undefined) refreshWith(variables, mutation.data)
  }
  return {
    submit: send,
    retry: () => {
      if (variables !== undefined) send(variables)
    },
    reset: () => {
      if (unknownOutcome) refresh()
      setUnknownOutcome(false)
      mutation.reset()
    },
    refresh,
    pending: mutation.isPending,
    result: mutation.isSuccess ? (mutation.data ?? null) : null,
    succeeded: mutation.isSuccess,
    failure: mutation.error ? failureOf(mutation.error) : null,
    locked: unknownOutcome,
    variables,
  }
}
