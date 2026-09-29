import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { searchClients } from '../api'
import { MAX_SEARCH_LENGTH, MIN_SEARCH_LENGTH } from '../schema'

const DEBOUNCE_MS = 250

/** `value`, once it has stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

/**
 * What is sent: trimmed and never longer than the server accepts (a paste can be longer).
 * Counted in characters (code points), as `char_length` counts them, so an emoji is never cut
 * in half.
 */
export function searchQueryOf(typed: string): string {
  return Array.from(typed.trim()).slice(0, MAX_SEARCH_LENGTH).join('').trim()
}

/**
 * Search as you type (contract 1.4 §3.3): 250 ms debounce, from 2 characters, the previous
 * results stay while the next ones load, 30″ cache, and a superseded request is aborted.
 * Below 2 characters there are no results at all: the previous ones are kept only while a next
 * search is on its way, never for an emptied box (they could still be tapped).
 */
export function useClientSearch(businessId: string, query: string) {
  const settled = useDebounced(searchQueryOf(query), DEBOUNCE_MS)
  const enabled = settled.length >= MIN_SEARCH_LENGTH
  const result = useQuery({
    queryKey: proKeys.clientSearch(businessId, settled),
    queryFn: ({ signal }) => searchClients(businessId, settled, signal),
    enabled,
    placeholderData: enabled ? keepPreviousData : undefined,
    staleTime: 30_000,
  })
  return { ...result, enabled, settledQuery: settled }
}
