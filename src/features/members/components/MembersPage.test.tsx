import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMBER_ROUTE_ID, type MemberContext } from '@/features/auth/loaders'
import { testFrame } from '@/features/settings/testFixtures'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { Member, RemoveResult, RoleChange, SetRoleResult } from '../schema'
import { MembersPage } from './MembersPage'

const api = vi.hoisted(() => ({
  fetchMembers: vi.fn<(businessId: string) => Promise<Member[]>>(),
  inviteMember: vi.fn(),
  setMemberRole: vi.fn<(businessId: string, change: RoleChange) => Promise<SetRoleResult>>(),
  removeMember: vi.fn<(businessId: string, userId: string) => Promise<RemoveResult>>(),
}))
vi.mock('../api', () => api)
const settingsApi = vi.hoisted(() => ({ fetchBusiness: vi.fn() }))
vi.mock('@/features/settings/api', () => settingsApi)
const staffApi = vi.hoisted(() => ({ fetchStaff: vi.fn() }))
vi.mock('@/features/staff/api', () => staffApi)
/** Every write goes through the step-up wrapper (the sheet itself is UI-AUTH's, tested there). */
const stepUp = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/features/auth/hooks/useStepUp', () => ({
  useStepUp:
    () =>
    <T,>(call: () => Promise<T>): Promise<T> => {
      stepUp.calls += 1
      return call()
    },
}))

// Test data only (synthetic ids and the demo shop's addresses).
const FRAME = testFrame()
const BUSINESS = FRAME.businessId
const IDS = {
  owner: '00000000-0000-4000-8000-00000000a001',
  owner2: '00000000-0000-4000-8000-00000000a011',
  manager: '00000000-0000-4000-8000-00000000a002',
  alex: '00000000-0000-4000-8000-00000000a003',
} as const
const MEMBERS: Member[] = [
  {
    userId: IDS.owner,
    email: 'owner@demo-barber.test',
    role: 'owner',
    staffId: null,
    staffName: null,
    signedIn: true,
    isSelf: true,
  },
  {
    userId: IDS.owner2,
    email: 'owner2@demo-barber.test',
    role: 'owner',
    staffId: null,
    staffName: null,
    signedIn: true,
    isSelf: false,
  },
  {
    userId: IDS.manager,
    email: 'manager@demo-barber.test',
    role: 'manager',
    staffId: null,
    staffName: null,
    signedIn: true,
    isSelf: false,
  },
  {
    userId: IDS.alex,
    email: 'alex@demo-barber.test',
    role: 'staff',
    staffId: FRAME.staff[1]?.id ?? null,
    staffName: 'Άλεξ',
    signedIn: false,
    isSelf: false,
  },
]

function owner(): MemberContext {
  const membership = { businessId: BUSINESS, role: 'owner' as const, staffId: null }
  return {
    user: { userId: IDS.owner, email: 'owner@demo-barber.test' },
    membership,
    memberships: [membership],
  }
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  stepUp.calls = 0
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
  api.fetchMembers.mockResolvedValue(MEMBERS)
  settingsApi.fetchBusiness.mockResolvedValue(FRAME.business)
  staffApi.fetchStaff.mockResolvedValue(FRAME.staff)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function open() {
  const router = createMemoryRouter(
    [
      {
        id: MEMBER_ROUTE_ID,
        loader: owner,
        hydrateFallbackElement: <p>loading</p>,
        children: [{ path: 'settings/members', element: <MembersPage /> }],
      },
    ],
    { initialEntries: ['/settings/members'] },
  )
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

async function list() {
  return within(await screen.findByRole('list', { name: 'Μέλη της επιχείρησης' }))
}

async function openMember(email: string) {
  fireEvent.click((await list()).getByRole('button', { name: new RegExp(email) }))
  return screen.findByRole('dialog', { name: email })
}

describe('MembersPage (contract 1.7 §6.8)', () => {
  it('lists every member; the caller’s own row has no action (D10)', async () => {
    open()
    const rows = await list()
    expect(rows.getAllByRole('listitem')).toHaveLength(4)
    expect(rows.getAllByRole('button')).toHaveLength(3)
    expect(rows.queryByRole('button', { name: /owner@demo-barber\.test/ })).toBeNull()
    const own = rows.getByText('owner@demo-barber.test').closest('li')
    expect(own).toHaveTextContent('Ιδιοκτήτης')
    expect(own).toHaveTextContent('εσύ')
    const alex = rows.getByRole('button', { name: /alex@demo-barber\.test/ })
    expect(alex).toHaveTextContent('Προσωπικό')
    expect(alex).toHaveTextContent('Στο ημερολόγιο: Άλεξ')
    expect(alex).toHaveTextContent('Δεν έχει συνδεθεί ακόμη')
    expect(screen.getByRole('button', { name: 'Πρόσκληση μέλους' })).toBeEnabled()
    expect(api.fetchMembers).toHaveBeenCalledWith(BUSINESS, expect.anything())
  })

  it('a role change: the consequences first, success only after the server answered', async () => {
    let answer: (value: SetRoleResult) => void = () => {}
    api.setMemberRole.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    open()
    const sheet = within(await openMember('manager@demo-barber.test'))
    expect(sheet.getByRole('radio', { name: 'Διαχειριστής' })).toBeChecked()
    expect(sheet.getByRole('button', { name: 'Αποθήκευση' })).toBeDisabled()
    expect(sheet.queryByText('Θα αποσυνδεθεί από όλες τις συσκευές του.')).toBeNull()

    fireEvent.click(sheet.getByRole('radio', { name: 'Προσωπικό' }))
    expect(sheet.getByText('Θα αποσυνδεθεί από όλες τις συσκευές του.')).toBeVisible()
    expect(sheet.getByText('Οι συσκευές κωδικών του θα σβηστούν.')).toBeVisible()
    fireEvent.click(sheet.getByRole('button', { name: 'Αποθήκευση' }))

    await waitFor(() => expect(api.setMemberRole).toHaveBeenCalledTimes(1))
    expect(api.setMemberRole).toHaveBeenCalledWith(BUSINESS, { userId: IDS.manager, role: 'staff' })
    expect(stepUp.calls).toBe(1)
    expect(sheet.queryByText('Ο ρόλος άλλαξε.')).toBeNull()

    answer({ user_id: IDS.manager, role: 'staff', previous_role: 'manager', changed: true })
    expect(await sheet.findByText('Ο ρόλος άλλαξε.')).toBeVisible()
    await waitFor(() => expect(api.fetchMembers).toHaveBeenCalledTimes(2))
  })

  it('staff → manager: they set up an authenticator app at the next sign-in', async () => {
    open()
    const sheet = within(await openMember('alex@demo-barber.test'))
    fireEvent.click(sheet.getByRole('radio', { name: 'Διαχειριστής' }))
    expect(sheet.getByText('Θα αποσυνδεθεί από όλες τις συσκευές του.')).toBeVisible()
    expect(sheet.getByText('Στην επόμενη σύνδεση θα ορίσει εφαρμογή κωδικών.')).toBeVisible()
    expect(sheet.queryByText('Οι συσκευές κωδικών του θα σβηστούν.')).toBeNull()
  })

  it('the last owner (AN026): its own text, nothing shown as done', async () => {
    api.setMemberRole.mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN026' }))
    open()
    const sheet = within(await openMember('owner2@demo-barber.test'))
    fireEvent.click(sheet.getByRole('radio', { name: 'Διαχειριστής' }))
    fireEvent.click(sheet.getByRole('button', { name: 'Αποθήκευση' }))
    expect(
      await sheet.findByText('Η επιχείρηση πρέπει να έχει πάντα τουλάχιστον έναν ιδιοκτήτη.'),
    ).toBeVisible()
    expect(sheet.queryByText('Ο ρόλος άλλαξε.')).toBeNull()
  })

  it('a closed code sheet: «Η ενέργεια δεν έγινε.» and the form stays', async () => {
    api.setMemberRole.mockRejectedValue(new RpcFailure({ kind: 'stepUpCancelled' }))
    open()
    const sheet = within(await openMember('manager@demo-barber.test'))
    fireEvent.click(sheet.getByRole('radio', { name: 'Ιδιοκτήτης' }))
    fireEvent.click(sheet.getByRole('button', { name: 'Αποθήκευση' }))
    expect(await sheet.findByText('Η ενέργεια δεν έγινε.')).toBeVisible()
    expect(sheet.getByRole('button', { name: 'Αποθήκευση' })).toBeEnabled()
  })

  it('removal: one confirmation, the calendar row stays, the result after the answer', async () => {
    let answer: (value: RemoveResult) => void = () => {}
    api.removeMember.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    open()
    const sheet = within(await openMember('alex@demo-barber.test'))
    fireEvent.click(sheet.getByRole('button', { name: 'Αφαίρεση από την επιχείρηση' }))
    expect(api.removeMember).not.toHaveBeenCalled()
    expect(sheet.getByText('Να αφαιρεθεί από την επιχείρηση;')).toBeVisible()
    expect(sheet.getByText('Θα αποσυνδεθεί από όλες τις συσκευές του.')).toBeVisible()
    expect(sheet.getByText('Ο επαγγελματίας «Άλεξ» μένει στο ημερολόγιο.')).toBeVisible()

    fireEvent.click(sheet.getByRole('button', { name: 'Αφαίρεση' }))
    await waitFor(() => expect(api.removeMember).toHaveBeenCalledWith(BUSINESS, IDS.alex))
    expect(stepUp.calls).toBe(1)
    expect(sheet.queryByText('Αφαιρέθηκε από την επιχείρηση.')).toBeNull()

    answer({ user_id: IDS.alex, removed: true })
    expect(await sheet.findByText('Αφαιρέθηκε από την επιχείρηση.')).toBeVisible()
  })

  it('«Άκυρο» of the removal sends nothing', async () => {
    open()
    const sheet = within(await openMember('alex@demo-barber.test'))
    fireEvent.click(sheet.getByRole('button', { name: 'Αφαίρεση από την επιχείρηση' }))
    fireEvent.click(sheet.getByRole('button', { name: 'Άκυρο' }))
    expect(sheet.getByRole('button', { name: 'Αφαίρεση από την επιχείρηση' })).toBeVisible()
    expect(api.removeMember).not.toHaveBeenCalled()
  })
})
