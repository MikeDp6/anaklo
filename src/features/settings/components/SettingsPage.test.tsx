import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemberLayout } from '@/app/pro/MemberLayout'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { SettingsPage } from './SettingsPage'

// The sign-out button of the layout is not under test here.
vi.mock('@/features/auth/components/SignOutButton', () => ({ SignOutButton: () => null }))

beforeAll(async () => {
  await initI18n(proCatalogues)
})

afterEach(() => {
  cleanup()
})

function open(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <MemberLayout />,
        children: [
          { index: true, element: <p>today</p> },
          { path: 'day', element: <p>day</p> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'settings/notifications', element: <h1>notifications</h1> },
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
}

describe('Ρυθμίσεις (contract 1.5 §4.1)', () => {
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

  it('lists «Ειδοποιήσεις» with its hint, linking to /settings/notifications', async () => {
    open('/settings')
    expect(await screen.findByRole('heading', { level: 1, name: 'Ρυθμίσεις' })).toBeVisible()
    const entry = screen.getByRole('link', { name: /^Ειδοποιήσεις/ })
    expect(entry).toHaveAttribute('href', '/settings/notifications')
    expect(entry).toHaveTextContent('Νέες κρατήσεις, ακυρώσεις και αλλαγές σε αυτή τη συσκευή.')
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
