import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { MemberRole } from '@/shared/lib/domain'
import { RpcFailure } from '@/shared/lib/rpcError'
import { MEMBER_ROUTE_ID, type MemberContext } from '../loaders'
import type * as MfaApi from '../mfaApi'
import type { VerifiedFactor } from '../mfaApi'
import type { StepUpDeps } from '../step-up'
import { StepUpContext } from '../stepUpContext'
import { SecurityPage } from './SecurityPage'

interface BusinessRead {
  readonly data: { timeZone: string; currency: string } | undefined
  readonly isError: boolean
}

const BUSINESS_LOADED: BusinessRead = {
  data: { timeZone: 'Europe/Athens', currency: 'EUR' },
  isError: false,
}

const mocks = vi.hoisted(() => ({
  listVerifiedFactors: vi.fn<() => Promise<VerifiedFactor[]>>(),
  removeFactor: vi.fn<(id: string) => Promise<void>>(),
  signOut: vi.fn(),
  useBusiness: vi.fn<() => BusinessRead>(),
}))
vi.mock('../mfaApi', async (importOriginal) => ({
  ...(await importOriginal<typeof MfaApi>()),
  listVerifiedFactors: mocks.listVerifiedFactors,
  removeFactor: mocks.removeFactor,
}))
vi.mock('../session', () => ({ signOut: mocks.signOut }))
vi.mock('@/features/settings/hooks/useBusiness', () => ({
  useBusiness: () => mocks.useBusiness(),
}))

// Synthetic data.
const IPHONE: VerifiedFactor = {
  id: '6f9619ff-8b86-4011-b42d-00c04fc96401',
  friendlyName: 'iPhone',
  createdAt: '2026-10-01T21:30:00Z',
}
const TABLET: VerifiedFactor = {
  id: '6f9619ff-8b86-4011-b42d-00c04fc96402',
  friendlyName: 'Tablet',
  createdAt: '2026-10-02T09:00:00Z',
}

function member(role: MemberRole): MemberContext {
  const membership = { businessId: '00000000-0000-4000-8000-000000000001', role, staffId: null }
  return {
    user: {
      userId: '00000000-0000-4000-8000-00000000a015',
      email: 'owner-devices-chrome@demo-barber.test',
    },
    membership,
    memberships: [membership],
  }
}

function open(role: MemberRole) {
  const askForCode = vi.fn(() => Promise.resolve(true))
  const deps: StepUpDeps = { askForCode, onAuthRecheck: vi.fn() }
  const router = createMemoryRouter(
    [
      {
        id: MEMBER_ROUTE_ID,
        loader: () => member(role),
        hydrateFallbackElement: <p>loading</p>,
        children: [
          { path: '/settings/security', element: <SecurityPage /> },
          { path: '/settings/security/add-device', element: <h1>add device</h1> },
          { path: '/settings', element: <h1>settings</h1> },
        ],
      },
      { path: '/login', element: <h1>login</h1> },
    ],
    { initialEntries: ['/settings/security'] },
  )
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StepUpContext value={deps}>
        <RouterProvider router={router} />
      </StepUpContext>
    </QueryClientProvider>,
  )
  return { router, askForCode }
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  mocks.listVerifiedFactors.mockResolvedValue([IPHONE, TABLET])
  mocks.removeFactor.mockResolvedValue(undefined)
  mocks.signOut.mockResolvedValue({ ok: true })
  mocks.useBusiness.mockReturnValue(BUSINESS_LOADED)
})

afterEach(() => {
  cleanup()
})

describe('SecurityPage (contract 1.7 §6.7)', () => {
  it('one device: «Αφαίρεση» disabled with the reason, and the banner with «Προσθήκη συσκευής»', async () => {
    mocks.listVerifiedFactors.mockResolvedValue([IPHONE])
    const { router } = open('owner')
    const remove = await screen.findByRole('button', { name: 'Αφαίρεση: iPhone' })
    expect(remove).toBeDisabled()
    expect(
      screen.getByText('Πρόσθεσε πρώτα άλλη συσκευή για να αφαιρέσεις αυτή.'),
    ).toBeInTheDocument()
    const banner = screen.getByRole('note')
    expect(banner).toHaveTextContent(
      'Έχεις μόνο μία συσκευή κωδικών. Αν τη χάσεις, θα χρειαστείς τη Nous.',
    )
    fireEvent.click(within(banner).getByRole('button', { name: 'Προσθήκη συσκευής' }))
    await screen.findByRole('heading', { name: 'add device' })
    expect(router.state.location.pathname).toBe('/settings/security/add-device')
  })

  it('the date of each device is shown in the business zone', async () => {
    mocks.listVerifiedFactors.mockResolvedValue([IPHONE])
    open('owner')
    // 21:30 UTC on 1 October is already 2 October in Athens.
    expect(await screen.findByText('Προστέθηκε 2 Οκτωβρίου 2026')).toBeInTheDocument()
  })

  it('a failed read of the business zone never hides the devices (rows without dates)', async () => {
    // Review fix (contract 1.7 §10): a cold reload offline used to leave a skeleton for good.
    mocks.useBusiness.mockReturnValue({ data: undefined, isError: true })
    open('owner')
    expect(await screen.findByRole('button', { name: 'Αφαίρεση: Tablet' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Αφαίρεση: iPhone' })).toBeEnabled()
    expect(screen.getAllByRole('button', { name: 'Προσθήκη συσκευής' })).toHaveLength(1)
    expect(screen.queryByText(/^Προστέθηκε/)).toBeNull()
    expect(screen.queryByText('Φόρτωση συσκευών…')).toBeNull()
  })

  it('while the business zone still loads, the list waits (no dates popping in)', async () => {
    mocks.useBusiness.mockReturnValue({ data: undefined, isError: false })
    open('owner')
    await waitFor(() => expect(mocks.listVerifiedFactors).toHaveBeenCalled())
    expect(await screen.findByText('Φόρτωση συσκευών…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Αφαίρεση: Tablet' })).toBeNull()
  })

  it('two devices: removal through the code sheet, «Η συσκευή αφαιρέθηκε.» only after the answer', async () => {
    let answer: () => void = () => {}
    mocks.removeFactor
      .mockRejectedValueOnce(new RpcFailure({ kind: 'stepUp', hint: 'fresh_totp_required' }))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            answer = resolve
          }),
      )
    const { askForCode } = open('owner')
    fireEvent.click(await screen.findByRole('button', { name: 'Αφαίρεση: Tablet' }))
    expect(screen.getByText('Να αφαιρεθεί η συσκευή «Tablet»;')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Αφαίρεση' }))
    await waitFor(() => expect(mocks.removeFactor).toHaveBeenCalledTimes(2))
    expect(askForCode).toHaveBeenCalledExactlyOnceWith('fresh_totp_required')
    expect(mocks.removeFactor).toHaveBeenLastCalledWith(TABLET.id)
    expect(screen.queryByText('Η συσκευή αφαιρέθηκε.')).toBeNull()
    mocks.listVerifiedFactors.mockResolvedValue([IPHONE])
    answer()
    expect(await screen.findByText('Η συσκευή αφαιρέθηκε.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Tablet')).toBeNull())
  })

  it('a refused removal says why and reloads the list', async () => {
    mocks.removeFactor.mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN027' }))
    open('manager')
    fireEvent.click(await screen.findByRole('button', { name: 'Αφαίρεση: Tablet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Αφαίρεση' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Είναι η μόνη σου συσκευή κωδικών. Πρόσθεσε πρώτα άλλη.',
    )
    await waitFor(() => expect(mocks.listVerifiedFactors).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Η συσκευή αφαιρέθηκε.')).toBeNull()
  })

  it('staff: only the sign-out of all devices, no device list', async () => {
    open('staff')
    expect(
      await screen.findByRole('button', { name: 'Αποσύνδεση από όλες τις συσκευές' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Συσκευές κωδικών' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Προσθήκη συσκευής' })).toBeNull()
    expect(mocks.listVerifiedFactors).not.toHaveBeenCalled()
  })

  it('«Αποσύνδεση από όλες τις συσκευές» asks first, then signs out everywhere', async () => {
    const { router } = open('staff')
    fireEvent.click(await screen.findByRole('button', { name: 'Αποσύνδεση από όλες τις συσκευές' }))
    expect(
      screen.getByText('Θα χρειαστεί νέα σύνδεση σε κάθε συσκευή, και σε αυτή.'),
    ).toBeInTheDocument()
    expect(mocks.signOut).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Αποσύνδεση παντού' }))
    await screen.findByRole('heading', { name: 'login' })
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'global' })
    expect(router.state.location.pathname).toBe('/login')
  })

  it('«Αποσύνδεση παντού» not confirmed by Auth: says so, stays here, and can try again', async () => {
    // Review fix (contract 1.7 §10): never a silent success on a security action.
    mocks.signOut.mockResolvedValueOnce({ ok: false })
    const { router } = open('owner')
    fireEvent.click(await screen.findByRole('button', { name: 'Αποσύνδεση από όλες τις συσκευές' }))
    fireEvent.click(screen.getByRole('button', { name: 'Αποσύνδεση παντού' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Δεν επιβεβαιώθηκε η αποσύνδεση από τις άλλες συσκευές. Αυτή η συσκευή μένει συνδεδεμένη· έλεγξε τη σύνδεση και δοκίμασε ξανά.',
    )
    expect(router.state.location.pathname).toBe('/settings/security')
    expect(screen.getByRole('button', { name: 'Αφαίρεση: Tablet' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Αποσύνδεση παντού' }))
    await screen.findByRole('heading', { name: 'login' })
    expect(mocks.signOut).toHaveBeenCalledTimes(2)
    expect(router.state.location.pathname).toBe('/login')
  })

  it('a sign-out that throws is reported the same way; «Άκυρο» clears the message', async () => {
    mocks.signOut.mockRejectedValueOnce(new Error('offline'))
    const { router } = open('staff')
    fireEvent.click(await screen.findByRole('button', { name: 'Αποσύνδεση από όλες τις συσκευές' }))
    fireEvent.click(screen.getByRole('button', { name: 'Αποσύνδεση παντού' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings/security')
    fireEvent.click(screen.getByRole('button', { name: 'Άκυρο' }))
    fireEvent.click(screen.getByRole('button', { name: 'Αποσύνδεση από όλες τις συσκευές' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
