import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMBER_ROUTE_ID, type MemberContext } from '@/features/auth/loaders'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import { toClientCard, type ClientCard } from '../schema'
import { cardItemJson, CLIENT_IDS, liveCardJson } from '../testFixtures'
import { ClientCardPage } from './ClientCardPage'

const api = vi.hoisted(() => ({
  fetchClientCard:
    vi.fn<(businessId: string, clientId: string, signal?: AbortSignal) => Promise<ClientCard>>(),
  searchClients: vi.fn(),
}))
vi.mock('../api', () => api)

// Test data only.
const B = CLIENT_IDS.business

function member(role: 'owner' | 'staff'): MemberContext {
  const membership = {
    businessId: B,
    role,
    staffId: role === 'staff' ? CLIENT_IDS.alex : CLIENT_IDS.nikos,
  }
  return {
    user: {
      userId: role === 'staff' ? CLIENT_IDS.staffUser : CLIENT_IDS.owner,
      email: `${role}@demo-barber.test`,
    },
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
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function open(path: string, role: 'owner' | 'staff' = 'owner') {
  const router = createMemoryRouter(
    [
      {
        id: MEMBER_ROUTE_ID,
        loader: () => member(role),
        hydrateFallbackElement: <p>loading</p>,
        children: [
          { path: 'clients', element: <p>search page</p> },
          { path: 'clients/:clientId', element: <ClientCardPage /> },
        ],
      },
    ],
    { initialEntries: [path] },
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

describe('ClientCardPage (contract 1.8 §4.3)', () => {
  it('shows the E17 skeleton until the card loads, then the card', async () => {
    let answer: (card: ClientCard) => void = () => {}
    api.fetchClientCard.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    open(`/clients/${CLIENT_IDS.client}`)
    expect(await screen.findByText('Φόρτωση καρτέλας πελάτη…')).toBeInTheDocument()
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(3)
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true')

    // The skeleton can show before the card query has called the API (membership first); answer
    // only once the pending call exists, or the answer goes nowhere and the card never comes.
    await waitFor(() => expect(api.fetchClientCard).toHaveBeenCalled())
    answer(toClientCard(liveCardJson()))
    expect(await screen.findByRole('heading', { level: 1, name: 'Γιώργος Π.' })).toBeVisible()
    expect(document.querySelectorAll('.skeleton')).toHaveLength(0)
    expect(api.fetchClientCard).toHaveBeenCalledWith(B, CLIENT_IDS.client, expect.anything())
    // The primary action: a call to the client's mobile.
    expect(screen.getByRole('link', { name: 'Κλήση +30 690 000 0001' })).toHaveAttribute(
      'href',
      'tel:+306900000001',
    )
  })

  it('a merged client redirects (replace) to the client it was merged into', async () => {
    api.fetchClientCard.mockImplementation((_b, clientId) =>
      Promise.resolve(
        clientId === CLIENT_IDS.merged
          ? toClientCard({
              state: 'merged',
              client_id: CLIENT_IDS.merged,
              merged_into_id: CLIENT_IDS.client,
            })
          : toClientCard(liveCardJson()),
      ),
    )
    const router = open(`/clients/${CLIENT_IDS.merged}`)
    expect(await screen.findByRole('heading', { level: 1, name: 'Γιώργος Π.' })).toBeVisible()
    expect(router.state.location.pathname).toBe(`/clients/${CLIENT_IDS.client}`)
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('an erased client: only that it was erased, nothing else of the card', async () => {
    api.fetchClientCard.mockResolvedValue(
      toClientCard({
        state: 'erased',
        client_id: CLIENT_IDS.client,
        erased_at: '2026-10-03T09:00:00+00:00',
      }),
    )
    open(`/clients/${CLIENT_IDS.client}`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ανωνυμοποιημένος πελάτης' }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Τα στοιχεία αυτού του πελάτη έχουν σβηστεί. Τα ραντεβού του μετρούν μόνο στα στατιστικά.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Πίσω στους πελάτες' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Ιστορικό' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Σημειώσεις' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ανωνυμοποίηση πελάτη' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('staff: no erase button (the server says can.erase false); colleagues’ amounts «—»', async () => {
    api.fetchClientCard.mockResolvedValue(
      toClientCard(
        liveCardJson({
          can: { erase: false, merge: false },
          history: [
            cardItemJson({ amount_cents: null, own: false, staff_name: 'Νίκος' }),
            cardItemJson({
              appointment_id: CLIENT_IDS.colleague,
              starts_at: '2026-08-26T07:00:00+00:00',
              ends_at: '2026-08-26T07:30:00+00:00',
              staff_id: CLIENT_IDS.alex,
              staff_name: 'Άλεξ',
              amount_cents: 1500,
              own: true,
            }),
          ],
        }),
      ),
    )
    open(`/clients/${CLIENT_IDS.client}`, 'staff')
    const history = await screen.findByRole('region', { name: 'Ιστορικό' })
    const rows = within(history).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Ποσό: —')
    expect(rows[0]).toHaveTextContent('Νίκος')
    expect(rows[1]).toHaveTextContent('Ποσό: 15,00')
    expect(screen.queryByRole('button', { name: 'Ανωνυμοποίηση πελάτη' })).toBeNull()
  })

  it('the owner sees «Ανωνυμοποίηση πελάτη»', async () => {
    api.fetchClientCard.mockResolvedValue(toClientCard(liveCardJson()))
    open(`/clients/${CLIENT_IDS.client}`)
    expect(await screen.findByRole('button', { name: 'Ανωνυμοποίηση πελάτη' })).toBeVisible()
  })

  it('without a mobile the primary action is «Επεξεργασία στοιχείων» (and only once)', async () => {
    const card = liveCardJson()
    api.fetchClientCard.mockResolvedValue(
      toClientCard({
        ...card,
        details: { ...(card.details as object), phone_e164: null, phone_verified_at: null },
      }),
    )
    open(`/clients/${CLIENT_IDS.client}`)
    expect(await screen.findByText('Χωρίς κινητό')).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Επεξεργασία στοιχείων' })).toHaveLength(1)
    expect(screen.queryByRole('link', { name: /^Κλήση/ })).toBeNull()
  })

  it('an id that is not a uuid: «Δεν βρέθηκε ο πελάτης.» without a request', async () => {
    open('/clients/not-a-uuid')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Δεν βρέθηκε ο πελάτης.' }),
    ).toBeVisible()
    expect(api.fetchClientCard).not.toHaveBeenCalled()
  })

  it('a refusal (unknown id, another business) is «not found», asked once', async () => {
    api.fetchClientCard.mockRejectedValue(new RpcFailure({ kind: 'forbidden' }))
    open(`/clients/${CLIENT_IDS.client}`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Δεν βρέθηκε ο πελάτης.' }),
    ).toBeVisible()
    await waitFor(() => expect(api.fetchClientCard).toHaveBeenCalledOnce())
  })

  it('offline on the first load: the reason and «Δοκίμασε ξανά»', async () => {
    api.fetchClientCard.mockRejectedValue(new RpcFailure({ kind: 'offline' }))
    open(`/clients/${CLIENT_IDS.client}`)
    // One automatic retry first (the app's default for reads), then the error.
    expect(
      await screen.findByRole('button', { name: 'Δοκίμασε ξανά' }, { timeout: 5000 }),
    ).toBeVisible()
  })
})
