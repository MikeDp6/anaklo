import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemberLayout } from '@/app/pro/MemberLayout'
import { MEMBER_ROUTE_ID, type MemberContext } from '@/features/auth/loaders'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { MemberRole } from '@/shared/lib/domain'
import { ManagerOnly } from './ManagerOnly'
import { SettingsPage } from './SettingsPage'

// The sign-out button of the layout is not under test here.
vi.mock('@/features/auth/components/SignOutButton', () => ({ SignOutButton: () => null }))

beforeAll(async () => {
  await initI18n(proCatalogues)
})

afterEach(() => {
  cleanup()
})

function member(role: MemberRole): MemberContext {
  const membership = {
    businessId: '00000000-0000-4000-8000-000000000001',
    role,
    staffId: null,
  }
  return {
    user: { userId: '00000000-0000-4000-8000-00000000a001', email: `${role}@demo-barber.test` },
    membership,
    memberships: [membership],
  }
}

function open(path: string, role: MemberRole = 'owner') {
  const router = createMemoryRouter(
    [
      {
        id: MEMBER_ROUTE_ID,
        loader: () => member(role),
        hydrateFallbackElement: <p>loading</p>,
        element: <MemberLayout />,
        children: [
          { index: true, element: <p>today</p> },
          { path: 'day', element: <p>day</p> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'settings/notifications', element: <h1>notifications</h1> },
          {
            element: <ManagerOnly />,
            children: [{ path: 'settings/closures', element: <h1>closures</h1> }],
          },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const ALL_ENTRIES = [
  ['Έκτακτη απουσία', '/settings/absence'],
  ['Υπηρεσίες', '/settings/services'],
  ['Προσωπικό', '/settings/staff'],
  ['Ωράρια', '/settings/hours'],
  ['Κλεισίματα και ειδικές μέρες', '/settings/closures'],
  ['Άδειες', '/settings/time-off'],
  ['Πολιτική κρατήσεων', '/settings/booking-policy'],
  ['Ειδοποιήσεις', '/settings/notifications'],
]

async function entries() {
  const list = await screen.findByRole('navigation', { name: 'Ρυθμίσεις' })
  return within(list)
    .getAllByRole('link')
    .map((link) => [
      link.querySelector('span > span')?.textContent ?? '',
      link.getAttribute('href') ?? '',
    ])
}

describe('Ρυθμίσεις (contract 1.5 §4.1, 1.6 §4.1)', () => {
  it('a third bottom tab «Ρυθμίσεις» leads to the settings list', async () => {
    open('/')
    const nav = await screen.findByRole('navigation', { name: 'Κύρια πλοήγηση' })
    const tabs = within(nav).getAllByRole('link')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Σήμερα', 'Ημερολόγιο', 'Ρυθμίσεις'])
    expect(within(nav).getByRole('link', { name: 'Ρυθμίσεις' })).toHaveAttribute(
      'href',
      '/settings',
    )
  })

  it.each(['owner', 'manager'] as const)('%s: the eight entries in order', async (role) => {
    open('/settings', role)
    expect(await screen.findByRole('heading', { level: 1, name: 'Ρυθμίσεις' })).toBeVisible()
    expect(await entries()).toEqual(ALL_ENTRIES)
  })

  it('staff: only «Ειδοποιήσεις», with its hint', async () => {
    open('/settings', 'staff')
    expect(await entries()).toEqual([['Ειδοποιήσεις', '/settings/notifications']])
    expect(screen.getByRole('link', { name: /^Ειδοποιήσεις/ })).toHaveTextContent(
      'Νέες κρατήσεις, ακυρώσεις και αλλαγές σε αυτή τη συσκευή.',
    )
  })

  it('the tab stays active on a settings screen', async () => {
    open('/settings/notifications')
    const nav = await screen.findByRole('navigation', { name: 'Κύρια πλοήγηση' })
    expect(within(nav).getByRole('link', { name: 'Ρυθμίσεις' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })
})

describe('ManagerOnly (contract 1.6 §4.1)', () => {
  it('staff are sent back to the settings index', async () => {
    const router = open('/settings/closures', 'staff')
    expect(await screen.findByRole('heading', { level: 1, name: 'Ρυθμίσεις' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/settings')
    expect(screen.queryByRole('heading', { name: 'closures' })).toBeNull()
  })

  it.each(['owner', 'manager'] as const)('%s reaches the screen', async (role) => {
    const router = open('/settings/closures', role)
    expect(await screen.findByRole('heading', { name: 'closures' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/settings/closures')
  })
})
