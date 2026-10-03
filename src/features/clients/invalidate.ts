import type { QueryClient } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'

/**
 * What each client write makes stale (contract 1.8 §3.4). Runs only after the server answered
 * (and after `forbidden`/`gone`, through `useSettingsMutation`; AN033 by the hooks).
 */

/** A note or a consent: the card only. */
export async function invalidateClientCard(
  queryClient: QueryClient,
  businessId: string,
  clientId: string,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: proKeys.clientCard(businessId, clientId) })
}

/**
 * Every list that prints a client's name or phone: the search and the cards, the day, «Σήμερα»,
 * the conflicts.
 */
function identityKeys(businessId: string) {
  return [
    proKeys.clientsAll(businessId),
    proKeys.dayAll(businessId),
    proKeys.todayAll(businessId),
    proKeys.conflictsAll(businessId),
  ] as const
}

/** A name or a phone changed: every list that prints them refetches. */
export async function invalidateClientIdentity(
  queryClient: QueryClient,
  businessId: string,
): Promise<void> {
  await Promise.all(
    identityKeys(businessId).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  )
}

/**
 * After an erase (contract 1.8 §3.4, SPEC §13 «appears nowhere»): the erased family's cards and
 * every list not on screen that may still hold the old name leave the cache (a cached search or
 * day would show it again for a moment before its refetch). A card still on screen is never
 * removed (its observer would keep the old card and never refetch): it is reset instead, so it
 * drops the old card at once and loads the erased view. The lists on screen refetch.
 */
export async function forgetErasedClients(
  queryClient: QueryClient,
  businessId: string,
  clientIds: Iterable<string>,
): Promise<void> {
  const cards = [...new Set(clientIds)].map((clientId) => proKeys.clientCard(businessId, clientId))
  for (const queryKey of [...cards, ...identityKeys(businessId)]) {
    queryClient.removeQueries({ queryKey, type: 'inactive' })
  }
  // The reset first: a card without data is then not refetched a second time by the invalidation.
  const resets = cards.map((queryKey) => queryClient.resetQueries({ queryKey, exact: true }))
  await Promise.all([...resets, invalidateClientIdentity(queryClient, businessId)])
}
