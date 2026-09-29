import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDS, testWorkspace } from '@/features/appointments/testFixtures'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { DayFrame, TodaySummary } from '../schema'
import { DayPage } from './DayPage'
import { TodayPage } from './TodayPage'

/**
 * A failed background refetch (the 60″ poll, focus, reconnect) keeps what is on screen: the day
 * grid, «Σήμερα», and above all an open sheet or a row's locked retry (contract 1.4 §0.15, §3.6).
 */

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ status: 'ready', workspace: testWorkspace() }),
}))

const calendarApi = vi.hoisted(() => ({
  fetchStaffSlots: vi.fn(),
  bookAppointment: vi.fn(),
  fetchDayFrame: vi.fn(),
  fetchStaffDay: vi.fn(),
  fetchTodaySummary: vi.fn(),
  setAppointmentStatus: vi.fn(),
  cancelAppointment: vi.fn(),
  moveAppointment: vi.fn(),
  localDayBounds: vi.fn(() => ({ from: '', to: '' })),
}))
vi.mock('@/features/calendar/api', () => calendarApi)

const REFRESH_FAILED = 'Δεν ανανεώθηκε: βλέπεις ό,τι φορτώθηκε τελευταία.'

// Test data only: Tuesday 29 September 2026, 09:00 in Athens.
const TODAY = '2026-09-29'
const FRAME: DayFrame = {
  localDate: TODAY,
  timeZone: 'Europe/Athens',
  dayStart: '2026-09-28T21:00:00+00:00',
  dayEnd: '2026-09-29T21:00:00+00:00',
  windows: [
    {
      staffId: IDS.nikos,
      startsAt: '2026-09-29T06:00:00+00:00',
      endsAt: '2026-09-29T11:00:00+00:00',
    },
  ],
  blocks: [],
}
const SUMMARY: TodaySummary = {
  localDate: TODAY,
  timeZone: 'Europe/Athens',
  currency: 'EUR',
  scope: 'business',
  counts: { total: 1, remaining: 0, toMark: 1 },
  expectedRevenueCents: 1300,
  next: [],
  gaps: [],
  toMark: [
    {
      appointmentId: IDS.appointment,
      staffId: IDS.nikos,
      startsAt: '2026-09-29T05:00:00+00:00',
      endsAt: '2026-09-29T05:30:00+00:00',
      status: 'booked',
      clientId: IDS.client,
      clientName: 'Γιώργος Π.',
      serviceIds: [IDS.cut],
    },
  ],
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-29T06:00:00Z') })
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function show(page: ReactNode, path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

describe('a failed background refetch keeps the screen', () => {
  it('day view: the grid and an open walk-in sheet stay; a notice offers a retry', async () => {
    calendarApi.fetchDayFrame.mockResolvedValue(FRAME)
    calendarApi.fetchStaffDay.mockResolvedValue([])
    const queryClient = show(<DayPage />, '/app/day')
    fireEvent.click(await screen.findByRole('button', { name: 'Walk-in: Νίκος' }))
    expect(screen.getByRole('dialog', { name: 'Walk-in: Νίκος' })).toBeInTheDocument()

    calendarApi.fetchDayFrame.mockRejectedValue(new RpcFailure({ kind: 'offline' }))
    calendarApi.fetchStaffDay.mockRejectedValue(new RpcFailure({ kind: 'offline' }))
    await act(() => queryClient.refetchQueries())

    expect(await screen.findByText(REFRESH_FAILED)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Walk-in: Νίκος' })).toBeInTheDocument()
    expect(screen.getByTestId('day-view')).toBeInTheDocument()
  })

  it('day view: a first load that fails shows the error, not an empty day', async () => {
    calendarApi.fetchDayFrame.mockRejectedValue(new RpcFailure({ kind: 'offline' }))
    calendarApi.fetchStaffDay.mockResolvedValue([])
    show(<DayPage />, '/app/day')
    expect(await screen.findByRole('alert')).toHaveTextContent('Δεν φορτώθηκε')
    expect(screen.queryByTestId('day-view')).toBeNull()
  })

  it('«Σήμερα»: the numbers and a row with a locked retry (unknown outcome) stay', async () => {
    calendarApi.fetchTodaySummary.mockResolvedValue(SUMMARY)
    calendarApi.setAppointmentStatus.mockRejectedValue(new RpcFailure({ kind: 'offline' }))
    const queryClient = show(<TodayPage />, '/app')
    const toMark = await screen.findByRole('region', { name: 'Προς σημείωση' })
    fireEvent.click(within(toMark).getByRole('button', { name: /^Ήρθε/ }))
    const retry = await within(toMark).findByRole('button', { name: 'Δοκίμασε ξανά' })

    calendarApi.fetchTodaySummary.mockRejectedValue(new RpcFailure({ kind: 'offline' }))
    await act(() => queryClient.refetchQueries({ queryKey: ['pro', IDS.business, 'today'] }))

    expect(await screen.findByText(REFRESH_FAILED)).toBeInTheDocument()
    expect(retry).toBeInTheDocument()
    expect(screen.getByTestId('today-total')).toBeInTheDocument()
  })
})
