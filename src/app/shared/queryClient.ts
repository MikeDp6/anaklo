import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { failureOf } from '@/shared/lib/rpcError'

/** A burst of refused requests (a whole screen's queries) asks for one new route decision. */
export const AUTH_RECHECK_THROTTLE_MS = 5_000

export interface QueryClientOptions {
  /**
   * A query or mutation was refused with `42501` without a step-up hint (`forbidden`) or had no
   * valid session (`unauthorized`): the role, the session or its level may have changed, so the
   * route guards run again (`decideAuthRoute`, contract 1.7 §6.2 item 4). At most once per
   * `AUTH_RECHECK_THROTTLE_MS`. The step-up kinds never trigger it: the code sheet answers them.
   */
  readonly onAuthFailure?: () => void
  /** For tests. */
  readonly now?: () => number
}

/**
 * Mutations run even when the browser reports offline and are never retried automatically:
 * a booking must not look saved before the server confirms it (SPEC §10), and retries reuse
 * the same idempotency key explicitly.
 */
export function createQueryClient({
  onAuthFailure,
  now = Date.now,
}: QueryClientOptions = {}): QueryClient {
  let lastRecheck = Number.NEGATIVE_INFINITY
  const onError = (error: unknown) => {
    if (!onAuthFailure) return
    const { kind } = failureOf(error)
    if (kind !== 'forbidden' && kind !== 'unauthorized') return
    const time = now()
    if (time - lastRecheck < AUTH_RECHECK_THROTTLE_MS) return
    lastRecheck = time
    onAuthFailure()
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
      mutations: { networkMode: 'always', retry: 0 },
    },
  })
}
