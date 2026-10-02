import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CancelInput, CancelResult, MoveInput, MoveResult } from '@/features/calendar/schema'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { ReassignCandidate, ReassignInput, ScheduleConflict } from '../schema'
import { SERVICE_NAMES, SETTINGS_IDS as IDS, testConflict, testFrame } from '../testFixtures'
import { ConflictResolver } from './ConflictResolver'

const calendarApi = vi.hoisted(() => ({
  cancelAppointment: vi.fn<(businessId: string, input: CancelInput) => Promise<CancelResult>>(),
  moveAppointment: vi.fn<(businessId: string, input: MoveInput) => Promise<MoveResult>>(),
}))
vi.mock('@/features/calendar/api', () => calendarApi)

const settingsApi = vi.hoisted(() => ({
  fetchReassignCandidates: vi.fn<() => Promise<ReassignCandidate[]>>(),
  reassignAppointment: vi.fn<(businessId: string, input: ReassignInput) => Promise<MoveResult>>(),
}))
vi.mock('@/features/settings/api', () => settingsApi)

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
  // 08:00 in Athens: the 10:00 appointment has not started yet.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-02T05:00:00Z') })
  settingsApi.fetchReassignCandidates.mockResolvedValue([
    { staffId: IDS.alex, free: true, blocker: null },
    { staffId: IDS.maria, free: false, blocker: 'busy' },
  ])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const MOVED: MoveResult = {
  appointmentId: IDS.first,
  staffId: IDS.alex,
  startsAt: '2026-10-02T07:00:00+00:00',
  endsAt: '2026-10-02T07:30:00+00:00',
  fromStaffId: IDS.nikos,
  fromStartsAt: '2026-10-02T07:00:00+00:00',
  warnings: [],
  replayed: false,
  notify: false,
  smsQueued: false,
}

const CANCELLED: CancelResult = {
  appointmentId: IDS.first,
  status: 'cancelled',
  fromStatus: 'booked',
  changed: true,
  cancelledBy: 'business',
  cancelReason: 'staff_unavailable',
  notify: true,
  smsQueued: true,
}

function open(conflict: ScheduleConflict = testConflict()) {
  const frame = testFrame()
  const onResolved = vi.fn()
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  const router = createMemoryRouter(
    [
      {
        path: '/settings/absence',
        element: (
          <ConflictResolver
            businessId={IDS.business}
            timeZone="Europe/Athens"
            conflict={conflict}
            staffNames={frame.staffNames}
            serviceNames={SERVICE_NAMES}
            onResolved={onResolved}
          />
        ),
      },
    ],
    { initialEntries: ['/settings/absence'] },
  )
  const invalidated = vi.spyOn(queryClient, 'invalidateQueries')
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { onResolved, invalidated }
}

/** The query keys `invalidateQueries` was called with so far. */
function keysOf(invalidated: { mock: { calls: readonly (readonly unknown[])[] } }): unknown[] {
  return invalidated.mock.calls.map((call) => (call[0] as { queryKey?: unknown }).queryKey)
}

const reassignGroup = () => screen.getByRole('group', { name: 'Ανάθεση σε συνάδελφο' })
const cancelGroup = () => screen.getByRole('group', { name: 'Ακύρωση' })

describe('ConflictResolver (contract 1.6 §4.9)', () => {
  it('shows when, who and why, and the free colleagues only, as buttons', async () => {
    open()
    expect(screen.getByText(/10:00–10:30/)).toBeVisible()
    expect(screen.getByText('Κώστας Μ.')).toBeVisible()
    expect(screen.getByText('Κούρεμα · Με: Νίκος')).toBeVisible()
    expect(within(screen.getByRole('list', { name: 'Γιατί' })).getByText('Άδεια')).toBeVisible()
    expect(await screen.findByRole('button', { name: 'Ανάθεση: Άλεξ' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Μαρία/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'Άνοιγμα στο ημερολόγιο' })).toHaveAttribute(
      'href',
      '/day?date=2026-10-02',
    )
  })

  it('nobody free: says so, and only the cancellation remains', async () => {
    settingsApi.fetchReassignCandidates.mockResolvedValue([
      { staffId: IDS.alex, free: false, blocker: 'off' },
    ])
    open()
    expect(
      await screen.findByText('Κανένας συνάδελφος δεν είναι ελεύθερος στις 10:00.'),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Ανάθεση/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Ακύρωση με SMS' })).toBeEnabled()
  })

  it('reassignment SMS is off by default, cancellation SMS on (D10)', async () => {
    settingsApi.reassignAppointment.mockResolvedValue(MOVED)
    open()
    await screen.findByRole('button', { name: 'Ανάθεση: Άλεξ' })
    expect(
      within(reassignGroup()).getByRole('checkbox', { name: /Ενημέρωση με SMS/ }),
    ).not.toBeChecked()
    expect(within(cancelGroup()).getByRole('checkbox', { name: /Ενημέρωση με SMS/ })).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Ανάθεση: Άλεξ' }))
    await waitFor(() => expect(settingsApi.reassignAppointment).toHaveBeenCalledTimes(1))
    expect(settingsApi.reassignAppointment.mock.calls[0]?.[1]).toMatchObject({
      appointmentId: IDS.first,
      newStaffId: IDS.alex,
      notify: false,
    })
  })

  it('the hand-over is conditional on the row as it was seen (staff and start), never a plain move', async () => {
    settingsApi.reassignAppointment.mockResolvedValue(MOVED)
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Ανάθεση: Άλεξ' }))
    await waitFor(() => expect(settingsApi.reassignAppointment).toHaveBeenCalledTimes(1))
    const { idempotencyKey, ...sent } = settingsApi.reassignAppointment.mock.calls[0]?.[1] ?? {}
    expect(sent).toEqual({
      appointmentId: IDS.first,
      expectedStaffId: IDS.nikos,
      expectedStartsAt: '2026-10-02T07:00:00+00:00',
      newStaffId: IDS.alex,
      notify: false,
    })
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    // `staff_move_appointment` takes the new start as given: a stale row would move it back.
    expect(calendarApi.moveAppointment).not.toHaveBeenCalled()
  })

  it('AN021 (moved or handed over elsewhere): the rows and the colleagues are asked again', async () => {
    settingsApi.reassignAppointment.mockRejectedValue(
      new RpcFailure({ kind: 'domain', code: 'AN021' }),
    )
    const { invalidated } = open()
    fireEvent.click(await screen.findByRole('button', { name: 'Ανάθεση: Άλεξ' }))
    expect(
      await screen.findByText(
        'Το ραντεβού άλλαξε στο μεταξύ. Δες την τρέχουσα κατάσταση και δοκίμασε ξανά.',
      ),
    ).toBeVisible()
    expect(screen.queryByText('Ανατέθηκε: Άλεξ')).toBeNull()
    await waitFor(() =>
      expect(keysOf(invalidated)).toContainEqual(proKeys.conflictsAll(IDS.business)),
    )
    expect(keysOf(invalidated)).toContainEqual(proKeys.reassignAll(IDS.business))
  })

  it('the cancellation sends `staff_unavailable` with the SMS', async () => {
    calendarApi.cancelAppointment.mockResolvedValue(CANCELLED)
    const { onResolved } = open()
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση με SMS' }))
    expect(await screen.findByText('Ακυρώθηκε')).toBeVisible()
    expect(screen.getByText('Ο πελάτης θα ενημερωθεί με SMS.')).toBeVisible()
    expect(calendarApi.cancelAppointment.mock.calls[0]?.[1]).toMatchObject({
      appointmentId: IDS.first,
      fromStatus: 'booked',
      reason: 'staff_unavailable',
      notify: true,
    })
    expect(onResolved).toHaveBeenCalledWith(IDS.first)
  })

  it('a closed shop: no reassignment, cancellation reason `shop_closed`', async () => {
    calendarApi.cancelAppointment.mockResolvedValue({ ...CANCELLED, cancelReason: 'shop_closed' })
    open(testConflict({ reasons: ['shop_closed'] }))
    expect(screen.queryByRole('group', { name: 'Ανάθεση σε συνάδελφο' })).toBeNull()
    expect(settingsApi.fetchReassignCandidates).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση με SMS' }))
    await waitFor(() => expect(calendarApi.cancelAppointment).toHaveBeenCalledTimes(1))
    expect(calendarApi.cancelAppointment.mock.calls[0]?.[1]).toMatchObject({
      reason: 'shop_closed',
    })
  })

  it.each([
    ['a landline', testConflict({ clientPhoneE164: '+302101234567' })],
    ['no phone', testConflict({ clientPhoneE164: null, clientName: null, clientId: null })],
    ['a past start', testConflict({ startsAt: '2026-10-02T04:30:00+00:00' })],
  ])('no SMS toggle for %s; the button says «Ακύρωση»', async (_, conflict) => {
    open(conflict)
    await screen.findByRole('button', { name: 'Ανάθεση: Άλεξ' })
    expect(screen.queryByRole('checkbox', { name: /Ενημέρωση με SMS/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Ακύρωση' })).toBeVisible()
  })

  it('the result shows only after the server answered', async () => {
    let answer: (result: MoveResult) => void = () => {}
    settingsApi.reassignAppointment.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    const { onResolved } = open()
    fireEvent.click(await screen.findByRole('button', { name: 'Ανάθεση: Άλεξ' }))
    expect(await screen.findByRole('button', { name: 'Ανάθεση…' })).toBeVisible()
    expect(screen.queryByText('Ανατέθηκε: Άλεξ')).toBeNull()
    expect(onResolved).not.toHaveBeenCalled()
    await act(async () => {
      answer(MOVED)
      await Promise.resolve()
    })
    expect(await screen.findByText('Ανατέθηκε: Άλεξ')).toBeVisible()
    expect(onResolved).toHaveBeenCalledWith(IDS.first)
    expect(screen.queryByRole('button', { name: /Ακύρωση/ })).toBeNull()
  })

  it('AN001: the colleague is no longer free; the candidates and the rows are asked again', async () => {
    settingsApi.reassignAppointment.mockRejectedValue(
      new RpcFailure({ kind: 'domain', code: 'AN001' }),
    )
    const { invalidated } = open()
    fireEvent.click(await screen.findByRole('button', { name: 'Ανάθεση: Άλεξ' }))
    expect(await screen.findByText('Ο συνάδελφος δεν είναι πια ελεύθερος.')).toBeVisible()
    await waitFor(() => expect(settingsApi.fetchReassignCandidates).toHaveBeenCalledTimes(2))
    // A row that changed meanwhile comes back with its current staff member and time.
    expect(keysOf(invalidated)).toContainEqual(proKeys.conflictsAll(IDS.business))
  })

  it('offline: locked, and the retry resends the same move with the same key', async () => {
    settingsApi.reassignAppointment
      .mockRejectedValueOnce(new RpcFailure({ kind: 'offline' }))
      .mockResolvedValueOnce(MOVED)
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Ανάθεση: Άλεξ' }))
    expect(await screen.findByText('Δεν αποθηκεύτηκε — χωρίς σύνδεση')).toBeVisible()
    expect(screen.getByRole('group', { name: 'Ακύρωση' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Δοκίμασε ξανά' }))
    expect(await screen.findByText('Ανατέθηκε: Άλεξ')).toBeVisible()
    const [first, second] = settingsApi.reassignAppointment.mock.calls
    expect(second?.[1]).toEqual(first?.[1])
    expect(second?.[1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  })
})
