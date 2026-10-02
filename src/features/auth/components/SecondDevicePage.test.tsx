import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { MfaRouteData } from '../loaders'
import type * as MfaApi from '../mfaApi'
import { StepUpContext } from '../stepUpContext'
import { SecondDevicePage } from './SecondDevicePage'

const api = vi.hoisted(() => ({
  listUnverifiedFactorIds: vi.fn(() => Promise.resolve([])),
  unenrollUnverified: vi.fn(),
  authorizeFactorAdd: vi.fn(),
  enrollTotp: vi.fn(),
  verifyTotp: vi.fn(),
}))
vi.mock('../mfaApi', async (importOriginal) => ({
  ...(await importOriginal<typeof MfaApi>()),
  ...api,
}))
// «Αποσύνδεση» is tested with the sign-out itself.
vi.mock('./SignOutButton', () => ({ SignOutButton: () => null }))

// Synthetic data (seed user …a013).
const DATA: MfaRouteData = {
  user: {
    userId: '00000000-0000-4000-8000-00000000a013',
    email: 'owner-enroll-chrome@demo-barber.test',
  },
  memberships: [
    { businessId: '00000000-0000-4000-8000-000000000001', role: 'owner', staffId: null },
  ],
  highestRole: 'owner',
  aal: 'aal2',
  verifiedFactors: [
    {
      id: '6f9619ff-8b86-4011-b42d-00c04fc96401',
      friendlyName: 'Συσκευή 1',
      createdAt: '2026-10-02T09:00:00Z',
    },
  ],
  next: '/day',
}

const LATER = 'Αργότερα'
const CONFIRM = 'Καταλαβαίνω ότι αν χάσω αυτή τη συσκευή θα χρειαστώ τη Nous'

function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: reduce, addEventListener: () => {}, removeEventListener: () => {} })),
  )
}

function open() {
  const router = createMemoryRouter(
    [
      {
        path: '/mfa/second-device',
        loader: () => DATA,
        hydrateFallbackElement: <p>loading</p>,
        element: <SecondDevicePage />,
      },
      { path: '/day', element: <h1>day</h1> },
      { path: '/', element: <h1>today</h1> },
    ],
    { initialEntries: ['/mfa/second-device'] },
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StepUpContext value={{ askForCode: () => Promise.resolve(true), onAuthRecheck: vi.fn() }}>
        <RouterProvider router={router} />
      </StepUpContext>
    </QueryClientProvider>,
  )
  return router
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  window.sessionStorage.clear()
  reducedMotion(false)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SecondDevicePage (contract 1.7 §6.5)', () => {
  it('«Αργότερα» stays disabled until the confirmation is checked, then goes on', async () => {
    const router = open()
    await screen.findByRole('heading', { name: 'Πρόσθεσε δεύτερη συσκευή' })
    const later = screen.getByRole('button', { name: LATER })
    expect(later).toBeDisabled()
    fireEvent.click(later)
    expect(router.state.location.pathname).toBe('/mfa/second-device')

    const box = screen.getByRole('checkbox', { name: CONFIRM })
    fireEvent.click(box)
    expect(later).toBeEnabled()
    fireEvent.click(box)
    expect(later).toBeDisabled()
    fireEvent.click(box)
    fireEvent.click(later)
    expect(await screen.findByRole('heading', { name: 'day' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/day')
  })

  it('«Προσθήκη τώρα» opens the wizard on the same screen, with another default name', async () => {
    const router = open()
    fireEvent.click(await screen.findByRole('button', { name: 'Προσθήκη τώρα' }))
    expect(
      await screen.findByRole('heading', { name: 'Κατέβασε μια εφαρμογή κωδικών' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Όνομα συσκευής')).toHaveValue('Συσκευή 2')
    expect(screen.queryByRole('button', { name: LATER })).toBeNull()
    expect(router.state.location.pathname).toBe('/mfa/second-device')
  })

  it('enters with E14; with reduced motion nothing moves', async () => {
    open()
    const title = await screen.findByRole('heading', { name: 'Πρόσθεσε δεύτερη συσκευή' })
    expect(title.closest('.step-enter')).not.toBeNull()
    cleanup()
    reducedMotion(true)
    open()
    const still = await screen.findByRole('heading', { name: 'Πρόσθεσε δεύτερη συσκευή' })
    expect(still.closest('.step-enter')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Προσθήκη τώρα' }))
    await screen.findByRole('heading', { name: 'Κατέβασε μια εφαρμογή κωδικών' })
    expect(document.querySelector('.step-enter, .step-enter-back')).toBeNull()
  })
})
