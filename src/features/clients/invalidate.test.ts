import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { forgetErasedClients, invalidateClientCard, invalidateClientIdentity } from './invalidate'
import { CLIENT_IDS } from './testFixtures'

const B = CLIENT_IDS.business

function spy() {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
  const keys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey)
  return { queryClient, keys }
}

describe('client invalidation (contract 1.8 §3.4)', () => {
  it('a name or phone change refreshes the search and cards, the day, «Σήμερα» and conflicts', async () => {
    const { queryClient, keys } = spy()
    await invalidateClientIdentity(queryClient, B)
    expect(keys()).toEqual([
      proKeys.clientsAll(B),
      proKeys.dayAll(B),
      proKeys.todayAll(B),
      proKeys.conflictsAll(B),
    ])
  })

  it('a note or a consent refreshes only that card', async () => {
    const { queryClient, keys } = spy()
    await invalidateClientCard(queryClient, B, CLIENT_IDS.client)
    expect(keys()).toEqual([proKeys.clientCard(B, CLIENT_IDS.client)])
  })

  it('after an erase: the family’s cards and every cached list off screen are dropped', async () => {
    const queryClient = new QueryClient()
    const cached = [
      proKeys.clientCard(B, CLIENT_IDS.client),
      proKeys.clientCard(B, CLIENT_IDS.merged),
      proKeys.clientSearch(B, 'ξενοφων'),
      proKeys.dayAll(B),
      proKeys.todayAll(B),
      proKeys.conflictsAll(B),
    ]
    for (const key of cached) queryClient.setQueryData(key, { name: 'Ξενοφών Ζαχαρίας' })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await forgetErasedClients(queryClient, B, [CLIENT_IDS.client, CLIENT_IDS.merged])

    for (const key of cached) expect(queryClient.getQueryData(key), String(key)).toBeUndefined()
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      proKeys.clientsAll(B),
      proKeys.dayAll(B),
      proKeys.todayAll(B),
      proKeys.conflictsAll(B),
    ])
  })

  it('a card still on screen is not dropped: it loses the old card at once and loads the erased view', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = proKeys.clientCard(B, CLIENT_IDS.client)
    const live = { state: 'live', fullName: 'Ξενοφών Ζαχαρίας' }
    const erased = { state: 'erased' }
    const queryFn = vi
      .fn<() => Promise<{ state: string }>>()
      .mockResolvedValueOnce(live)
      .mockResolvedValue(erased)
    // The card page's observer (staleTime as useClientCard).
    const observer = new QueryObserver(queryClient, { queryKey, queryFn, staleTime: 30_000 })
    const unsubscribe = observer.subscribe(() => {})
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(live))

    const forgetting = forgetErasedClients(queryClient, B, [CLIENT_IDS.client])
    // Never the old card again, also before the refetch answers.
    expect(observer.getCurrentResult().data).toBeUndefined()
    await forgetting

    expect(observer.getCurrentResult().data).toEqual(erased)
    expect(queryClient.getQueryData(queryKey)).toEqual(erased)
    expect(queryFn).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('the clients prefix covers the search and every card', () => {
    const prefix = proKeys.clientsAll(B)
    expect(proKeys.clientSearch(B, 'giorgos').slice(0, prefix.length)).toEqual(prefix)
    expect(proKeys.clientCard(B, CLIENT_IDS.client).slice(0, prefix.length)).toEqual(prefix)
  })
})
