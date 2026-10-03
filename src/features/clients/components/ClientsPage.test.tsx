import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMBER_ROUTE_ID, type MemberContext } from '@/features/auth/loaders'
import { testFrame } from '@/features/settings/testFixtures'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { ClientHit } from '../schema'
import { CLIENT_IDS } from '../testFixtures'
import { ClientsPage } from './ClientsPage'

const api = vi.hoisted(() => ({
  searchClients:
    vi.fn<(businessId: string, query: string, signal?: AbortSignal) => Promise<ClientHit[]>>(),
}))
vi.mock('../api', () => api)
const settingsApi = vi.hoisted(() => ({ fetchBusiness: vi.fn() }))
vi.mock('@/features/settings/api', () => settingsApi)

// Test data only: the demo shop.
const B = CLIENT_IDS.business
const GIORGOS: ClientHit = {
  id: CLIENT_IDS.client,
  fullName: 'Γιώργος Π.',
  phoneE164: '+306900000001',
  lastVisitAt: '2026-09-23T07:00:00+00:00',
}
const SEARCH = 'Αναζήτηση πελάτη'

function owner(): MemberContext {
  const membership = { businessId: B, role: 'owner' as const, staffId: null }
  return {
    user: { userId: CLIENT_IDS.owner, email: 'owner@demo-barber.test' },
    membership,
    memberships: [membership],
  }
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
  settingsApi.fetchBusiness.mockResolvedValue(testFrame().business)
  api.searchClients.mockResolvedValue([GIORGOS])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function open(entry: string | { pathname: string; search?: string; state?: unknown }) {
  const router = createMemoryRouter(
    [
      {
        id: MEMBER_ROUTE_ID,
        loader: owner,
        hydrateFallbackElement: <p>loading</p>,
        children: [
          { path: 'clients', element: <ClientsPage /> },
          { path: 'clients/:clientId', element: <p>card page</p> },
        ],
      },
    ],
    { initialEntries: [entry] },
  )
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('ClientsPage (contract 1.8 §4.2)', () => {
  it('below 2 characters: the hint only, no search', async () => {
    open('/clients')
    const box = await screen.findByRole('searchbox', { name: SEARCH })
    expect(box).toHaveAccessibleDescription(
      'Όνομα (και με λατινικά) ή τα τελευταία ψηφία του τηλεφώνου.',
    )
    expect(box).toHaveAttribute('maxlength', '100')
    fireEvent.change(box, { target: { value: 'γ' } })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(api.searchClients).not.toHaveBeenCalled()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText('Δεν βρέθηκε πελάτης.')).toBeNull()
  })

  it('results link to the card; the settled query goes into ?q= with replace', async () => {
    const router = open('/clients')
    fireEvent.change(await screen.findByRole('searchbox', { name: SEARCH }), {
      target: { value: 'giorgos' },
    })
    const list = within(await screen.findByRole('list', { name: 'Αποτελέσματα αναζήτησης' }))
    const link = list.getByRole('link', { name: /Γιώργος Π\./ })
    expect(link).toHaveAttribute('href', `/clients/${CLIENT_IDS.client}`)
    expect(link).toHaveTextContent('+30 690 000 0001')
    expect(link).toHaveTextContent(/Τελευταία επίσκεψη .+/)
    expect(api.searchClients).toHaveBeenCalledWith(B, 'giorgos', expect.anything())
    await waitFor(() => expect(router.state.location.search).toBe('?q=giorgos'))
    expect(router.state.historyAction).toBe('REPLACE')

    fireEvent.click(link)
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/clients/${CLIENT_IDS.client}`),
    )
    expect(router.state.location.state).toEqual({ back: '/clients?q=giorgos' })
  })

  it('?q= is restored: the box and the results come back', async () => {
    open('/clients?q=giorgos')
    expect(await screen.findByRole('searchbox', { name: SEARCH })).toHaveValue('giorgos')
    expect(await screen.findByRole('link', { name: /Γιώργος Π\./ })).toBeVisible()
  })

  it('no client found: «Δεν βρέθηκε πελάτης.»', async () => {
    api.searchClients.mockResolvedValue([])
    open('/clients?q=zzz')
    expect(await screen.findByText('Δεν βρέθηκε πελάτης.')).toBeVisible()
  })

  it('after an erase: «Ο πελάτης ανωνυμοποιήθηκε.», cleared by the next search', async () => {
    const router = open({ pathname: '/clients', state: { notice: 'erased' } })
    expect(await screen.findByText('Ο πελάτης ανωνυμοποιήθηκε.')).toBeVisible()
    fireEvent.change(screen.getByRole('searchbox', { name: SEARCH }), {
      target: { value: 'giorgos' },
    })
    await waitFor(() => expect(router.state.location.search).toBe('?q=giorgos'))
    // The router state changes first; React renders the new location in a transition, so the
    // DOM is awaited too (under load the synchronous check raced the render).
    await waitFor(() => expect(screen.queryByText('Ο πελάτης ανωνυμοποιήθηκε.')).toBeNull())
  })

  it('while the first results load: two E17 rows', async () => {
    api.searchClients.mockImplementation(() => new Promise(() => {}))
    open('/clients?q=giorgos')
    expect(await screen.findByText('Αναζήτηση…')).toBeInTheDocument()
    expect(document.querySelectorAll('.skeleton')).toHaveLength(2)
  })
})
