import { useLocation, useParams } from 'react-router'
import { Id } from '@fn-shared/booking-schemas.ts'
import { useMember } from '@/features/auth/hooks/useMember'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { failureOf, type RpcFailureInfo } from '@/shared/lib/rpcError'
import type { ClientCard } from '../schema'
import { useClientCard } from './useClientCard'

export type ClientCardPageState =
  | { readonly kind: 'notFound' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly failure: RpcFailureInfo; readonly retry: () => void }
  | {
      readonly kind: 'ready'
      readonly card: ClientCard
      /** A background refetch failed: the card stays, with the 1.4 `RefreshError` line. */
      readonly refreshFailure: RpcFailureInfo | null
      readonly retry: () => void
    }

/** The back link returns to the search the card was opened from, else to «Πελάτες». */
function backOf(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'back' in state) {
    const { back } = state
    if (typeof back === 'string' && /^\/clients(\?|$)/.test(back)) return back
  }
  return '/clients'
}

/**
 * `clients/:clientId` (contract 1.8 §4.3): an id that is not a uuid is «not found» without a
 * request; a refusal (`forbidden`: unknown, or another business's client) is «not found» too.
 */
export function useClientCardPage() {
  const { clientId } = useParams()
  const member = useMember()
  const businessId = member.membership.businessId
  const valid = Id.safeParse(clientId).success ? (clientId ?? null) : null
  const query = useClientCard(businessId, valid)
  const location = useLocation()
  const retry = () => void query.refetch()

  let state: ClientCardPageState
  if (valid === null) state = { kind: 'notFound' }
  else if (failedWithoutData(query)) {
    const failure = failureOf(query.error)
    state = failure.kind === 'forbidden' ? { kind: 'notFound' } : { kind: 'error', failure, retry }
  } else if (!query.data) state = { kind: 'loading' }
  else {
    state = {
      kind: 'ready',
      card: query.data,
      refreshFailure: failedRefresh(query) ? failureOf(query.error) : null,
      retry,
    }
  }
  return { state, businessId, userId: member.user.userId, back: backOf(location.state) }
}
