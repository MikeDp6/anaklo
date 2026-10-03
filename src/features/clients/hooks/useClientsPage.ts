import { useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { useMember } from '@/features/auth/hooks/useMember'
import { useBusiness } from '@/features/settings/hooks/useBusiness'
import { ERASED_NOTICE } from './useClientMutations'
import { useClientSearch } from './useClientSearch'

function noticeOf(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    'notice' in state &&
    state.notice === ERASED_NOTICE
  )
}

/**
 * «Πελάτες» (contract 1.8 §4.2): the box starts from `?q=` (so «Πίσω» from a card finds the same
 * search), the settled query goes back into `?q=` with `replace` (one history entry, and the
 * notice of an erase, carried in the location state, clears with it), and the business zone
 * dates the last visits.
 */
export function useClientsPage() {
  const businessId = useMember().membership.businessId
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const [query, setQuery] = useState(() => params.get('q') ?? '')
  const search = useClientSearch(businessId, query)
  const business = useBusiness(businessId)
  const settled = search.settledQuery
  const inUrl = params.get('q') ?? ''

  useEffect(() => {
    if (settled !== inUrl) setParams(settled ? { q: settled } : {}, { replace: true })
  }, [settled, inUrl, setParams])

  // No search (fewer than 2 characters): no results, never those of an earlier query.
  const hits = search.enabled ? (search.data ?? []) : []
  return {
    query,
    setQuery,
    search,
    hits,
    timeZone: business.data?.timeZone ?? null,
    erased: noticeOf(location.state),
    /** Where a card's back link returns: this search. */
    back: `/clients${settled ? `?${new URLSearchParams({ q: settled }).toString()}` : ''}`,
  }
}
