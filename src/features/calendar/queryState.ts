/**
 * What a failed read means for the screen (contract 1.4 §3.6). TanStack Query keeps the last data
 * when a background refetch (60″ poll, focus, reconnect, invalidation) fails and still reports
 * `isError`, so an error alone must never replace what is on screen: one lost poll on a shaky
 * connection would unmount the day, «Σήμερα» and any open sheet with it (and a locked «Δοκίμασε
 * ξανά» of an unknown outcome, contract §0.15).
 */
interface ReadState {
  readonly isError: boolean
  readonly data: unknown
}

/** Failed before anything loaded: the error is all there is to show. */
export function failedWithoutData(query: ReadState): boolean {
  return query.isError && query.data === undefined
}

/** A refetch failed but the last data is still there: keep it, with an inline notice. */
export function failedRefresh(query: ReadState): boolean {
  return query.isError && query.data !== undefined
}
