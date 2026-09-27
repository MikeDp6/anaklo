import { QueryClient } from '@tanstack/react-query'

/**
 * Mutations run even when the browser reports offline and are never retried automatically:
 * a booking must not look saved before the server confirms it (SPEC §10), and retries reuse
 * the same idempotency key explicitly.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
      mutations: { networkMode: 'always', retry: 0 },
    },
  })
}
