import { useCallback, useEffect, useState } from 'react'
import { resolveShortCode } from '@/features/booking/api'
import { resolveBookingRoute } from './route'

export type ShortLinkState = 'loading' | 'not-found' | 'error'

function replaceLocation(path: string): void {
  window.location.replace(path)
}

/**
 * `/r/<code>` resolved by the page itself (the Worker could not reach Supabase, contract §8):
 * asks `/api` for the slug and replaces the address with `/<slug>`, only ever a booking page of
 * this site. The state covers the wait and the two dead ends; `retry` asks again. `go` must be a
 * stable function (tests pass their own).
 */
export function useShortLink(
  code: string,
  go: (path: string) => void = replaceLocation,
): { state: ShortLinkState; retry: () => void } {
  const [state, setState] = useState<ShortLinkState>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    resolveShortCode(code, controller.signal).then(
      (slug) => {
        if (controller.signal.aborted) return
        if (slug && resolveBookingRoute(`/${slug}`).kind === 'business') go(`/${slug}`)
        else setState('not-found')
      },
      () => {
        if (!controller.signal.aborted) setState('error')
      },
    )
    return () => controller.abort()
  }, [code, attempt, go])

  const retry = useCallback(() => {
    setState('loading')
    setAttempt((value) => value + 1)
  }, [])

  return { state, retry }
}
