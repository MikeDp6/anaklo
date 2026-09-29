import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SEARCH_LENGTH } from '../schema'
import { searchQueryOf, useClientSearch } from './useClientSearch'

const clientsApi = vi.hoisted(() => ({ searchClients: vi.fn() }))
vi.mock('../api', () => clientsApi)

// Test data only.
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const HIT = { id: '00000000-0000-4000-8000-00000000c001', fullName: 'Γιώργος Π.' }

afterEach(() => {
  vi.clearAllMocks()
})

function setup(initial: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(({ query }: { query: string }) => useClientSearch(BUSINESS, query), {
    wrapper,
    initialProps: { query: initial },
  })
}

describe('useClientSearch', () => {
  it('an emptied box has no results: the previous ones are not kept (they could be tapped)', async () => {
    clientsApi.searchClients.mockResolvedValue([
      { ...HIT, phoneE164: '+306900000001', lastVisitAt: null },
    ])
    const { result, rerender } = setup('Γιώργος')
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    rerender({ query: '' })
    await waitFor(() => expect(result.current.enabled).toBe(false))
    expect(result.current.data).toBeUndefined()

    rerender({ query: 'Γ' })
    await waitFor(() => expect(result.current.settledQuery).toBe('Γ'))
    expect(result.current.enabled).toBe(false)
    expect(result.current.data).toBeUndefined()
  })

  it('never sends more than the server accepts (a pasted long name is cut, not refused)', async () => {
    clientsApi.searchClients.mockResolvedValue([])
    const long = `${'Αναστασία-Μαρία Παπαδοπούλου '.repeat(5)}`.trim()
    expect(Array.from(long).length).toBeGreaterThan(MAX_SEARCH_LENGTH)
    setup(long)
    await waitFor(() => expect(clientsApi.searchClients).toHaveBeenCalledTimes(1))
    const [, sent] = clientsApi.searchClients.mock.calls[0] as [string, string]
    expect(Array.from(sent).length).toBeLessThanOrEqual(MAX_SEARCH_LENGTH)
    expect(long.startsWith(sent)).toBe(true)
  })

  it('counts characters as the server does: an emoji at the limit is never cut in half', () => {
    const query = `${'α'.repeat(MAX_SEARCH_LENGTH - 1)}😀😀`
    const sent = searchQueryOf(query)
    expect(Array.from(sent)).toHaveLength(MAX_SEARCH_LENGTH)
    expect(sent.endsWith('😀')).toBe(true)
  })
})
