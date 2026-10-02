import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { AbsenceInput, AbsenceResult, ReassignCandidate, ScheduleConflict } from '../schema'
import { SERVICE_NAMES, SETTINGS_IDS as IDS, testConflict, testFrame } from '../testFixtures'
import { AbsenceFlow } from './AbsenceFlow'

const calendarApi = vi.hoisted(() => ({
  cancelAppointment: vi.fn(),
  moveAppointment: vi.fn(),
}))
vi.mock('@/features/calendar/api', () => calendarApi)

const settingsApi = vi.hoisted(() => ({
  markAbsence: vi.fn<(businessId: string, input: AbsenceInput) => Promise<AbsenceResult>>(),
  fetchScheduleConflicts: vi.fn<() => Promise<ScheduleConflict[]>>(),
  fetchReassignCandidates: vi.fn<() => Promise<ReassignCandidate[]>>(),
  fetchTimeOff: vi.fn(() => Promise.resolve([])),
}))
vi.mock('@/features/settings/api', () => settingsApi)

beforeAll(async () => {
  await initI18n(proCatalogues)
})

const CONFLICTS = [
  testConflict(),
  testConflict({
    appointmentId: IDS.second,
    startsAt: '2026-10-02T08:00:00+00:00',
    endsAt: '2026-10-02T08:30:00+00:00',
    clientName: 'Ελένη Π.',
  }),
]

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
  // 08:17:45 in Athens.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-02T05:17:45Z') })
  settingsApi.fetchScheduleConflicts.mockResolvedValue(CONFLICTS)
  settingsApi.fetchReassignCandidates.mockResolvedValue([
    { staffId: IDS.alex, free: true, blocker: null },
  ])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function result(input: AbsenceInput): AbsenceResult {
  return {
    timeOffId: '00000000-0000-4000-8000-00000000e001',
    staffId: input.staffId,
    startsAt: input.from,
    endsAt: input.to,
    reason: 'leave',
    created: true,
    extended: false,
    conflicts: CONFLICTS,
  }
}

function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  const router = createMemoryRouter(
    [
      {
        path: '/settings/absence',
        element: <AbsenceFlow frame={testFrame()} serviceNames={SERVICE_NAMES} />,
      },
      { path: '/', element: <h1>today</h1> },
    ],
    { initialEntries: ['/settings/absence'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function chooseNikos() {
  fireEvent.change(screen.getByLabelText('Ποιος λείπει'), { target: { value: IDS.nikos } })
}

describe('AbsenceFlow (contract 1.6 §4.10, flow 6)', () => {
  it('asks who is out, from now to the end of the day; nothing before a choice', () => {
    open()
    expect(screen.getByText('Από 08:17 ως το τέλος της ημέρας')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Καταχώρηση απουσίας' })).toBeDisabled()
    chooseNikos()
    expect(screen.getByRole('button', { name: 'Καταχώρηση απουσίας' })).toBeEnabled()
  })

  it('lists nothing before `mark_absence` answers, then the window’s appointments', async () => {
    let answer: (value: AbsenceResult) => void = () => {}
    settingsApi.markAbsence.mockImplementation(
      (_b, input) =>
        new Promise((resolve) => {
          answer = () => resolve(result(input))
        }),
    )
    open()
    chooseNikos()
    fireEvent.click(screen.getByRole('button', { name: 'Καταχώρηση απουσίας' }))
    expect(await screen.findByRole('button', { name: 'Καταχώρηση…' })).toBeDisabled()
    expect(screen.queryByText('Κώστας Μ.')).toBeNull()
    expect(settingsApi.fetchScheduleConflicts).not.toHaveBeenCalled()
    expect(settingsApi.markAbsence.mock.calls[0]?.[1]).toEqual({
      staffId: IDS.nikos,
      from: '2026-10-02T05:17:00.000Z',
      to: '2026-10-02T21:00:00.000Z',
    })

    await act(async () => {
      answer(result({ staffId: IDS.nikos, from: '', to: '' }))
      await Promise.resolve()
    })
    expect(await screen.findByText('Η απουσία καταχωρήθηκε.')).toBeVisible()
    expect(screen.getByText('Κώστας Μ.')).toBeVisible()
    expect(screen.getByText('Ελένη Π.')).toBeVisible()
  })

  it('offline: locked; the retry sends the identical absence', async () => {
    settingsApi.markAbsence
      .mockRejectedValueOnce(new RpcFailure({ kind: 'offline' }))
      .mockImplementationOnce((_b, input) => Promise.resolve(result(input)))
    open()
    chooseNikos()
    fireEvent.click(screen.getByRole('button', { name: 'Καταχώρηση απουσίας' }))
    expect(await screen.findByText('Δεν αποθηκεύτηκε — χωρίς σύνδεση')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Καταχώρηση απουσίας' })).toBeNull()
    expect(screen.getByLabelText('Ποιος λείπει')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Δοκίμασε ξανά' }))
    expect(await screen.findByText('Η απουσία καταχωρήθηκε.')).toBeVisible()
    const [first, second] = settingsApi.markAbsence.mock.calls
    expect(second?.[1]).toEqual(first?.[1])
  })

  it('resolved rows keep their result after the list refetches without them; then «Όλα…»', async () => {
    const cancelled = new Set<string>()
    // The server's list no longer has the cancelled appointments.
    settingsApi.fetchScheduleConflicts.mockImplementation(() =>
      Promise.resolve(CONFLICTS.filter((row) => !cancelled.has(row.appointmentId))),
    )
    settingsApi.markAbsence.mockImplementation((_b, input) => Promise.resolve(result(input)))
    calendarApi.cancelAppointment.mockImplementation((_b, input: { appointmentId: string }) => {
      cancelled.add(input.appointmentId)
      return Promise.resolve({
        appointmentId: input.appointmentId,
        status: 'cancelled',
        fromStatus: 'booked',
        changed: true,
        cancelledBy: 'business',
        cancelReason: 'staff_unavailable',
        notify: true,
        smsQueued: true,
      })
    })
    open()
    chooseNikos()
    fireEvent.click(screen.getByRole('button', { name: 'Καταχώρηση απουσίας' }))
    const first = await screen.findAllByRole('button', { name: 'Ακύρωση με SMS' })
    fireEvent.click(first[0] as HTMLElement)
    expect(await screen.findByText('Ακυρώθηκε')).toBeVisible()
    expect(screen.queryByText('Όλα τα ραντεβού τακτοποιήθηκαν.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση με SMS' }))
    await waitFor(() => expect(screen.getAllByText('Ακυρώθηκε')).toHaveLength(2))
    await waitFor(() => expect(settingsApi.fetchScheduleConflicts).toHaveBeenCalled())
    expect(screen.getByText('Κώστας Μ.')).toBeVisible()
    expect(screen.getByText('Ελένη Π.')).toBeVisible()
    expect(screen.getByText('Όλα τα ραντεβού τακτοποιήθηκαν.')).toBeVisible()
  })

  it('no appointment in the window: says so, with «Τέλος»', async () => {
    settingsApi.fetchScheduleConflicts.mockResolvedValue([])
    settingsApi.markAbsence.mockImplementation((_b, input) =>
      Promise.resolve({ ...result(input), created: false, extended: true, conflicts: [] }),
    )
    open()
    chooseNikos()
    fireEvent.click(screen.getByRole('button', { name: 'Καταχώρηση απουσίας' }))
    expect(
      await screen.findByText('Υπήρχε ήδη άδεια· επεκτάθηκε ως το τέλος της ημέρας.'),
    ).toBeVisible()
    expect(screen.getByText('Κανένα ραντεβού ως το τέλος της ημέρας.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Τέλος' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'today' })).toBeVisible())
  })
})
