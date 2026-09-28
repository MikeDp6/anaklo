import { useCallback, useEffect, useState } from 'react'
import { fetchCatalogue, readInitialCatalogue } from '../api'
import type { Catalogue } from '../schema'

export type CatalogueState =
  | { status: 'loading' }
  | { status: 'ready'; catalogue: Catalogue }
  | { status: 'not-found' }
  | { status: 'error' }

/**
 * The booking page's catalogue: the copy the Worker injected when there is one (no round trip),
 * otherwise one fetch through `/api` (phase 1 §1.3, budget tactic 2). No TanStack Query on this
 * page (tactic 3): one request, one retry button.
 */
export function useCatalogue(slug: string): { state: CatalogueState; retry: () => void } {
  const [state, setState] = useState<CatalogueState>(() => {
    const initial = readInitialCatalogue(slug)
    return initial ? { status: 'ready', catalogue: initial } : { status: 'loading' }
  })
  const [attempt, setAttempt] = useState(0)
  const needsFetch = state.status === 'loading'

  useEffect(() => {
    if (!needsFetch) return
    const controller = new AbortController()
    fetchCatalogue(slug, controller.signal).then(
      (catalogue) => setState(catalogue ? { status: 'ready', catalogue } : { status: 'not-found' }),
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      },
    )
    return () => controller.abort()
  }, [slug, needsFetch, attempt])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((value) => value + 1)
  }, [])

  return { state, retry }
}
