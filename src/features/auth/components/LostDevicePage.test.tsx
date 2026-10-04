import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { MfaRouteData } from '../loaders'
import type { VerifiedFactor } from '../mfaApi'
import { LostDevicePage } from './LostDevicePage'

vi.mock('./SignOutButton', () => ({ SignOutButton: () => null }))

// Synthetic data; the support contact is a placeholder, not Nous's real one.
const DEVICE: VerifiedFactor = {
  id: '6f9619ff-8b86-4011-b42d-00c04fc96401',
  friendlyName: 'iPhone',
  createdAt: '2026-10-01T09:00:00Z',
}

function open(factors: VerifiedFactor[]) {
  const data: MfaRouteData = {
    user: {
      userId: '00000000-0000-4000-8000-00000000a013',
      email: 'owner-enroll-chrome@demo-barber.test',
    },
    memberships: [
      { businessId: '00000000-0000-4000-8000-000000000001', role: 'owner', staffId: null },
    ],
    highestRole: 'owner',
    aal: 'aal1',
    verifiedFactors: factors,
    enrolmentBlocked: false,
    next: null,
  }
  const router = createMemoryRouter(
    [
      {
        path: '/mfa/lost-device',
        loader: () => data,
        hydrateFallbackElement: <p>loading</p>,
        element: <LostDevicePage />,
      },
    ],
    { initialEntries: ['/mfa/lost-device'] },
  )
  render(<RouterProvider router={router} />)
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('LostDevicePage (contract 1.7 §6.5)', () => {
  it('shows Nous’s contact from the environment and how the identity is checked', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com')
    vi.stubEnv('VITE_SUPPORT_PHONE', '+302100000000')
    open([DEVICE])
    await screen.findByRole('heading', { name: 'Χάσατε τη συσκευή σας;' })
    expect(
      screen.getByRole('link', { name: 'Email στη Nous: support@example.com' }),
    ).toHaveAttribute('href', 'mailto:support@example.com')
    expect(screen.getByRole('link', { name: 'Κλήση στη Nous: +30 210 000 0000' })).toHaveAttribute(
      'href',
      'tel:+302100000000',
    )
    expect(screen.getByText(/θα σε καλέσουμε στο τηλέφωνο του καταστήματος/)).toBeInTheDocument()
    expect(
      screen.getByText('Η εφαρμογή δεν έχει άλλο τρόπο εισόδου χωρίς τη συσκευή.'),
    ).toBeInTheDocument()
  })

  it('a missing or malformed contact is hidden, the explanation stays', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', '')
    vi.stubEnv('VITE_SUPPORT_PHONE', 'call us')
    open([DEVICE])
    await screen.findByRole('heading', { name: 'Χάσατε τη συσκευή σας;' })
    expect(screen.queryByRole('link', { name: /Nous/ })).toBeNull()
    expect(screen.getByText(/επικοινώνησε με τη Nous/)).toBeInTheDocument()
  })

  it('no bypass of any kind: no button, only links back to the code and to Nous', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com')
    vi.stubEnv('VITE_SUPPORT_PHONE', '+302100000000')
    open([DEVICE])
    await screen.findByRole('heading', { name: 'Χάσατε τη συσκευή σας;' })
    expect(screen.queryAllByRole('button')).toEqual([])
    const targets = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(targets.sort()).toEqual([
      '/mfa/challenge',
      'mailto:support@example.com',
      'tel:+302100000000',
    ])
  })

  it('with a second device: its code, back on the code screen', async () => {
    open([
      DEVICE,
      { ...DEVICE, id: '6f9619ff-8b86-4011-b42d-00c04fc96402', friendlyName: 'Tablet' },
    ])
    const link = await screen.findByRole('link', { name: 'Κωδικός από τη δεύτερη συσκευή' })
    expect(link).toHaveAttribute('href', '/mfa/challenge')
  })

  it('with one device there is no «second device» option', async () => {
    open([DEVICE])
    await screen.findByRole('heading', { name: 'Χάσατε τη συσκευή σας;' })
    expect(screen.queryByRole('link', { name: 'Κωδικός από τη δεύτερη συσκευή' })).toBeNull()
  })
})
