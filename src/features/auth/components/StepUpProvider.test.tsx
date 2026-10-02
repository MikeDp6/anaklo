import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { failureOf, RpcFailure } from '@/shared/lib/rpcError'
import { useStepUp } from '../hooks/useStepUp'
import type * as MfaApi from '../mfaApi'
import type { VerifiedFactor } from '../mfaApi'
import { StepUpProvider } from './StepUpProvider'

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  listVerifiedFactors: vi.fn<() => Promise<VerifiedFactor[]>>(),
  stepUpVerify: vi.fn(),
}))
vi.mock('../api', () => ({ getSessionUser: mocks.getSessionUser }))
vi.mock('../mfaApi', async (importOriginal) => ({
  ...(await importOriginal<typeof MfaApi>()),
  listVerifiedFactors: mocks.listVerifiedFactors,
  stepUpVerify: mocks.stepUpVerify,
}))

// Synthetic data.
const IPHONE: VerifiedFactor = {
  id: '6f9619ff-8b86-4011-b42d-00c04fc96401',
  friendlyName: 'iPhone',
  createdAt: '2026-10-01T09:00:00Z',
}
const TABLET: VerifiedFactor = {
  ...IPHONE,
  id: '6f9619ff-8b86-4011-b42d-00c04fc96402',
  friendlyName: 'Tablet',
}
const STALE = new RpcFailure({ kind: 'stepUp', hint: 'fresh_totp_required' })

/** Two critical actions at once, each refused once for a stale code, then accepted. */
function Actions({ calls }: { calls: { a: number; b: number } }) {
  const stepUp = useStepUp()
  const [results, setResults] = useState<string[]>([])
  const run = (name: 'a' | 'b') =>
    stepUp(() => {
      calls[name] += 1
      return calls[name] === 1 ? Promise.reject(STALE) : Promise.resolve(name)
    }).then(
      (value) => setResults((all) => [...all, `ok:${value}`]),
      (error: unknown) => setResults((all) => [...all, `failed:${failureOf(error).kind}`]),
    )
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void run('a')
          void run('b')
        }}
      >
        run
      </button>
      <output>{results.sort().join(',')}</output>
    </>
  )
}

function open() {
  const calls = { a: 0, b: 0 }
  const loader = vi.fn(() => null)
  const router = createMemoryRouter(
    [
      {
        path: '/',
        loader,
        hydrateFallbackElement: <p>loading</p>,
        element: (
          <StepUpProvider>
            <Actions calls={calls} />
          </StepUpProvider>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { calls, loader }
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  mocks.getSessionUser.mockResolvedValue({
    userId: '00000000-0000-4000-8000-00000000a015',
    email: 'owner-devices-chrome@demo-barber.test',
  })
  mocks.listVerifiedFactors.mockResolvedValue([IPHONE, TABLET])
  mocks.stepUpVerify.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('StepUpProvider (contract 1.7 §6.6)', () => {
  it('concurrent requests share one sheet; a verified code retries each exactly once', async () => {
    const { calls } = open()
    fireEvent.click(await screen.findByRole('button', { name: 'run' }))
    const sheet = await screen.findByRole('dialog', { name: 'Επιβεβαίωση με κωδικό' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(
      within(sheet).getByText(
        'Για να συνεχίσεις, γράψε τον κωδικό 6 ψηφίων από την εφαρμογή κωδικών.',
      ),
    ).toBeInTheDocument()
    // Two devices: the choice, as on the code screen.
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Tablet' }))
    fireEvent.change(within(sheet).getByLabelText('Κωδικός 6 ψηφίων'), {
      target: { value: '123456' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Συνέχεια' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ok:a,ok:b'))
    expect(mocks.stepUpVerify).toHaveBeenCalledExactlyOnceWith(TABLET.id, '123456')
    expect(calls).toEqual({ a: 2, b: 2 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a wrong code keeps the sheet open with the reason; no retry of the action', async () => {
    mocks.stepUpVerify.mockResolvedValue({ ok: false, reason: 'invalid_code' })
    const { calls } = open()
    fireEvent.click(await screen.findByRole('button', { name: 'run' }))
    const sheet = await screen.findByRole('dialog', { name: 'Επιβεβαίωση με κωδικό' })
    fireEvent.change(within(sheet).getByLabelText('Κωδικός 6 ψηφίων'), {
      target: { value: '000000' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Συνέχεια' }))
    expect(
      await within(sheet).findByText(
        'Ο κωδικός δεν είναι σωστός. Γράψε αυτόν που δείχνει τώρα η εφαρμογή.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(calls).toEqual({ a: 1, b: 1 })
  })

  it('«Άκυρο» closes it: both actions end as cancelled, nothing retried', async () => {
    const { calls } = open()
    fireEvent.click(await screen.findByRole('button', { name: 'run' }))
    const sheet = await screen.findByRole('dialog', { name: 'Επιβεβαίωση με κωδικό' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Άκυρο' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'failed:stepUpCancelled,failed:stepUpCancelled',
      ),
    )
    expect(calls).toEqual({ a: 1, b: 1 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('no verified device: no sheet, cancelled, and the route guards decide again', async () => {
    mocks.listVerifiedFactors.mockResolvedValue([])
    const { calls, loader } = open()
    fireEvent.click(await screen.findByRole('button', { name: 'run' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'failed:stepUpCancelled,failed:stepUpCancelled',
      ),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls).toEqual({ a: 1, b: 1 })
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
  })
})
