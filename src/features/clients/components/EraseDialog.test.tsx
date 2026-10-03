import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StepUpDeps } from '@/features/auth/step-up'
import { StepUpContext } from '@/features/auth/stepUpContext'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { StepUpHint } from '@/shared/lib/domain'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { EraseResult } from '../schema'
import { CLIENT_IDS } from '../testFixtures'
import { EraseDialog } from './EraseDialog'

const api = vi.hoisted(() => ({
  eraseClient: vi.fn<(businessId: string, clientId: string) => Promise<EraseResult>>(),
}))
vi.mock('../api', () => api)

// Test data only.
const B = CLIENT_IDS.business
const C = CLIENT_IDS.client
const ERASED: EraseResult = {
  clientId: C,
  erased: true,
  erasedAt: '2026-10-03T09:00:00+00:00',
  erasedIds: [C],
  appointmentsKept: 3,
  notesDeleted: 2,
  consentsDeleted: 1,
  messagesWiped: 4,
  otpChallengesWiped: 1,
  devicesRevoked: 1,
  tokensRevoked: 2,
  suppressed: 1,
}
const TEXT = {
  confirm: 'Ανωνυμοποίηση',
  understand: 'Καταλαβαίνω ότι δεν αναιρείται.',
  failed: 'Δεν έγινε. Δοκίμασε ξανά.',
  cancelled: 'Η ενέργεια δεν έγινε.',
  AN032: 'Ο πελάτης έχει μελλοντικό ραντεβού. Ακύρωσέ το πρώτα και μετά κάνε την ανωνυμοποίηση.',
} as const

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

/** Where the dialog navigates on success: shows the location state it was given. */
function Landing() {
  const location = useLocation()
  return <p data-testid="landing">{JSON.stringify(location.state)}</p>
}

/** The dialog under a fake code sheet (the 1.7 `StepUpContext`): the real `withStepUp` runs. */
function open(askForCode: StepUpDeps['askForCode']) {
  const deps = { askForCode: vi.fn(askForCode), onAuthRecheck: vi.fn() }
  const onClose = vi.fn()
  const router = createMemoryRouter(
    [
      {
        path: '/clients/:clientId',
        element: (
          <StepUpContext value={deps}>
            <EraseDialog businessId={B} clientId={C} onClose={onClose} />
          </StepUpContext>
        ),
      },
      { path: '/clients', element: <Landing /> },
    ],
    { initialEntries: [`/clients/${C}`] },
  )
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { deps, onClose, router }
}

function confirmButton() {
  return screen.getByRole('button', { name: TEXT.confirm })
}

function confirm() {
  fireEvent.click(screen.getByRole('checkbox', { name: TEXT.understand }))
  fireEvent.click(confirmButton())
}

function stepUpFailure(hint: StepUpHint) {
  return new RpcFailure({ kind: 'stepUp', hint })
}

describe('EraseDialog (contract 1.8 §4.8, plan 1.8 Vitest)', () => {
  it('says what happens first; «Ανωνυμοποίηση» stays disabled until the checkbox', async () => {
    open(() => Promise.resolve(true))
    expect(await screen.findByRole('dialog', { name: 'Ανωνυμοποίηση πελάτη' })).toBeVisible()
    expect(screen.getByText('Δεν αναιρείται.')).toBeVisible()
    expect(confirmButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: TEXT.understand }))
    expect(confirmButton()).toBeEnabled()
    expect(api.eraseClient).not.toHaveBeenCalled()
  })

  it.each(['aal2_required', 'fresh_totp_required'] as const)(
    '%s → the code sheet once → exactly one retry → back to the search with the notice, after the answer',
    async (hint) => {
      let answer: (value: EraseResult) => void = () => {}
      api.eraseClient.mockRejectedValueOnce(stepUpFailure(hint)).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve
          }),
      )
      const { deps, router } = open(() => Promise.resolve(true))
      await screen.findByRole('dialog')
      confirm()

      await waitFor(() => expect(api.eraseClient).toHaveBeenCalledTimes(2))
      expect(deps.askForCode).toHaveBeenCalledOnce()
      expect(deps.askForCode).toHaveBeenCalledWith(hint)
      expect(api.eraseClient).toHaveBeenNthCalledWith(2, B, C)
      // Nothing shown as done while the retry has not answered.
      expect(router.state.location.pathname).toBe(`/clients/${C}`)
      expect(screen.queryByTestId('landing')).toBeNull()

      answer(ERASED)
      expect(await screen.findByTestId('landing')).toHaveTextContent('{"notice":"erased"}')
      expect(router.state.location.pathname).toBe('/clients')
      expect(router.state.historyAction).toBe('REPLACE')
      expect(api.eraseClient).toHaveBeenCalledTimes(2)
    },
  )

  it('a retry refused again (also with the other hint) → «Δεν έγινε», no third call, no second sheet', async () => {
    api.eraseClient
      .mockRejectedValueOnce(stepUpFailure('aal2_required'))
      .mockRejectedValueOnce(stepUpFailure('fresh_totp_required'))
    const { deps, router } = open(() => Promise.resolve(true))
    await screen.findByRole('dialog')
    confirm()

    expect(await screen.findByText(TEXT.failed)).toBeVisible()
    expect(api.eraseClient).toHaveBeenCalledTimes(2)
    expect(deps.askForCode).toHaveBeenCalledOnce()
    expect(router.state.location.pathname).toBe(`/clients/${C}`)
    expect(screen.getByRole('dialog', { name: 'Ανωνυμοποίηση πελάτη' })).toBeVisible()
  })

  it('the code sheet closed → «Η ενέργεια δεν έγινε.», the dialog stays, no retry', async () => {
    api.eraseClient.mockRejectedValueOnce(stepUpFailure('fresh_totp_required'))
    const { deps, onClose, router } = open(() => Promise.resolve(false))
    await screen.findByRole('dialog')
    confirm()

    expect(await screen.findByText(TEXT.cancelled)).toBeVisible()
    expect(deps.askForCode).toHaveBeenCalledOnce()
    expect(api.eraseClient).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    expect(router.state.location.pathname).toBe(`/clients/${C}`)
    expect(screen.getByRole('dialog', { name: 'Ανωνυμοποίηση πελάτη' })).toBeVisible()
  })

  it('AN032 (an upcoming appointment) → its text; no code sheet', async () => {
    api.eraseClient.mockRejectedValueOnce(new RpcFailure({ kind: 'domain', code: 'AN032' }))
    const { deps } = open(() => Promise.resolve(true))
    await screen.findByRole('dialog')
    confirm()

    expect(await screen.findByText(TEXT.AN032)).toBeVisible()
    expect(deps.askForCode).not.toHaveBeenCalled()
    expect(api.eraseClient).toHaveBeenCalledOnce()
  })

  it('cannot be closed while the call runs (X, Esc, «Άκυρο»): the answer still lands here', async () => {
    let answer: (value: EraseResult) => void = () => {}
    api.eraseClient.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const { onClose, router } = open(() => Promise.resolve(true))
    const dialog = await screen.findByRole('dialog', { name: 'Ανωνυμοποίηση πελάτη' })
    confirm()
    expect(await screen.findByRole('button', { name: 'Γίνεται ανωνυμοποίηση…' })).toBeDisabled()

    const x = screen.getByRole('button', { name: 'Κλείσιμο' })
    expect(x).toBeDisabled()
    fireEvent.click(x)
    // Esc on a modal <dialog> fires `cancel`.
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(screen.getByRole('button', { name: 'Άκυρο' })).toBeDisabled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Ανωνυμοποίηση πελάτη' })).toBeVisible()

    answer(ERASED)
    expect(await screen.findByTestId('landing')).toHaveTextContent('{"notice":"erased"}')
    expect(router.state.location.pathname).toBe('/clients')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes again once the call answered with a failure', async () => {
    api.eraseClient.mockRejectedValueOnce(new RpcFailure({ kind: 'domain', code: 'AN032' }))
    const { onClose } = open(() => Promise.resolve(true))
    await screen.findByRole('dialog')
    confirm()
    expect(await screen.findByText(TEXT.AN032)).toBeVisible()
    const x = screen.getByRole('button', { name: 'Κλείσιμο' })
    expect(x).toBeEnabled()
    fireEvent.click(x)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('a committed erase answered on its retry (erased: false) is still a success', async () => {
    api.eraseClient.mockResolvedValueOnce({ ...ERASED, erased: false, erasedIds: [] })
    open(() => Promise.resolve(true))
    await screen.findByRole('dialog')
    confirm()
    expect(await screen.findByTestId('landing')).toHaveTextContent('{"notice":"erased"}')
  })
})
