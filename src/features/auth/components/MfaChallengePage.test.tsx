import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { MfaRouteData } from '../loaders'
import type * as MfaApi from '../mfaApi'
import type { VerifiedFactor } from '../mfaApi'
import { MfaChallengePage } from './MfaChallengePage'

const api = vi.hoisted(() => ({ verifyTotp: vi.fn() }))
vi.mock('../mfaApi', async (importOriginal) => ({
  ...(await importOriginal<typeof MfaApi>()),
  ...api,
}))
vi.mock('./SignOutButton', () => ({ SignOutButton: () => null }))

// Synthetic data.
const IPHONE: VerifiedFactor = {
  id: '6f9619ff-8b86-4011-b42d-00c04fc96401',
  friendlyName: 'iPhone',
  createdAt: '2026-10-01T09:00:00Z',
}
const TABLET: VerifiedFactor = {
  id: '6f9619ff-8b86-4011-b42d-00c04fc96402',
  friendlyName: 'Tablet',
  createdAt: '2026-10-02T09:00:00Z',
}

function data(factors: VerifiedFactor[]): MfaRouteData {
  return {
    user: {
      userId: '00000000-0000-4000-8000-00000000a015',
      email: 'owner-devices-chrome@demo-barber.test',
    },
    memberships: [
      { businessId: '00000000-0000-4000-8000-000000000001', role: 'owner', staffId: null },
    ],
    highestRole: 'owner',
    aal: 'aal1',
    verifiedFactors: factors,
    next: '/day',
  }
}

function open(factors: VerifiedFactor[]) {
  const router = createMemoryRouter(
    [
      {
        path: '/mfa/challenge',
        loader: () => data(factors),
        hydrateFallbackElement: <p>loading</p>,
        element: <MfaChallengePage />,
      },
      { path: '/mfa/second-device', element: <h1>second device</h1> },
      { path: '/mfa/lost-device', element: <h1>lost device</h1> },
      { path: '/day', element: <h1>day</h1> },
    ],
    { initialEntries: ['/mfa/challenge?next=%2Fday'] },
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  api.verifyTotp.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('MfaChallengePage (contract 1.7 §6.5)', () => {
  it('two devices: a choice by name, the first preselected; the chosen one is verified', async () => {
    const router = open([IPHONE, TABLET])
    await screen.findByRole('heading', { name: 'Κωδικός από την εφαρμογή κωδικών' })
    expect(screen.getByRole('group', { name: 'Συσκευή' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'iPhone' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Tablet' }))
    fireEvent.change(screen.getByLabelText('Κωδικός 6 ψηφίων'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Συνέχεια' }))
    await waitFor(() => expect(api.verifyTotp).toHaveBeenCalledWith(TABLET.id, '123456'))
    // Two devices: no reminder, straight to where the user was going.
    await screen.findByRole('heading', { name: 'day' })
    expect(router.state.location.pathname).toBe('/day')
  })

  it('one device: no choice; after the code the second-device reminder, keeping next', async () => {
    const router = open([IPHONE])
    await screen.findByRole('heading', { name: 'Κωδικός από την εφαρμογή κωδικών' })
    expect(screen.queryByRole('radio')).toBeNull()
    const field = screen.getByLabelText('Κωδικός 6 ψηφίων')
    expect(field).toHaveAttribute('inputmode', 'numeric')
    expect(field).toHaveAttribute('autocomplete', 'one-time-code')
    fireEvent.change(field, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Συνέχεια' }))
    await screen.findByRole('heading', { name: 'second device' })
    expect(router.state.location.pathname).toBe('/mfa/second-device')
    expect(router.state.location.search).toBe('?next=%2Fday')
  })

  it('a wrong code says so and stays', async () => {
    api.verifyTotp.mockResolvedValue({ ok: false, reason: 'invalid_code' })
    const router = open([IPHONE])
    fireEvent.change(await screen.findByLabelText('Κωδικός 6 ψηφίων'), {
      target: { value: '000000' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Συνέχεια' }))
    expect(
      await screen.findByText(
        'Ο κωδικός δεν είναι σωστός. Γράψε αυτόν που δείχνει τώρα η εφαρμογή.',
      ),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/mfa/challenge')
  })

  it('a code that is not 6 digits is not sent', async () => {
    open([IPHONE])
    fireEvent.change(await screen.findByLabelText('Κωδικός 6 ψηφίων'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Συνέχεια' }))
    expect(await screen.findByText('Ο κωδικός έχει 6 ψηφία.')).toBeInTheDocument()
    expect(api.verifyTotp).not.toHaveBeenCalled()
  })

  it('«Χάσατε τη συσκευή σας;» leads to the lost-device screen', async () => {
    open([IPHONE])
    const link = await screen.findByRole('link', { name: 'Χάσατε τη συσκευή σας;' })
    expect(link).toHaveAttribute('href', '/mfa/lost-device?next=%2Fday')
  })
})
