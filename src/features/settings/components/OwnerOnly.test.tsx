import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { MEMBER_ROUTE_ID, type MemberContext } from '@/features/auth/loaders'
import type { MemberRole } from '@/shared/lib/domain'
import { OwnerOnly } from './OwnerOnly'

afterEach(() => {
  cleanup()
})

// Test data only (synthetic ids of the demo shop).
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

function open(path: string, role: MemberRole) {
  const router = createMemoryRouter(
    [
      {
        id: MEMBER_ROUTE_ID,
        loader: () => member(role),
        hydrateFallbackElement: <p>loading</p>,
        children: [
          { path: 'settings', element: <h1>settings</h1> },
          {
            element: <OwnerOnly />,
            children: [
              { path: 'settings/members', element: <h1>members</h1> },
              { path: 'settings/identity', element: <h1>identity</h1> },
            ],
          },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('OwnerOnly (contract 1.7 §6.1, D6)', () => {
  it.each([
    ['manager', '/settings/members'],
    ['staff', '/settings/members'],
    ['manager', '/settings/identity'],
    ['staff', '/settings/identity'],
  ] as const)('%s on %s goes back to the settings index', async (role, path) => {
    const router = open(path, role)
    expect(await screen.findByRole('heading', { name: 'settings' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/settings')
    expect(screen.queryByRole('heading', { name: /members|identity/ })).toBeNull()
  })

  it.each(['/settings/members', '/settings/identity'])('the owner reaches %s', async (path) => {
    const router = open(path, 'owner')
    expect(await screen.findByRole('heading', { name: path.split('/')[2] })).toBeVisible()
    expect(router.state.location.pathname).toBe(path)
  })
})
