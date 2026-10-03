import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CancelInput,
  DayAppointment,
  MoveInput,
  Slot,
  StatusInput,
  StatusResult,
} from '@/features/calendar/schema'
import type { SlotsQuery } from '@/shared/lib/proQueryKeys'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import { IDS, testAppointment, testWorkspace } from '../testFixtures'
import { AppointmentSheet } from './AppointmentSheet'

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

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
  // 09:00 in Athens: the 10:00 appointment has not started yet.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-29T06:00:00Z') })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function open(appointment: DayAppointment) {
  calendarApi.fetchStaffDay.mockResolvedValue([appointment])
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  const onClose = vi.fn()
  // A router: the sheet links to the client's card (contract 1.8 §4.10).
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AppointmentSheet
          workspace={testWorkspace()}
          target={{
            appointmentId: appointment.id,
            staffId: appointment.staffId,
            localDate: '2026-09-29',
          }}
          today="2026-09-29"
          onClose={onClose}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return { onClose, queryClient, unmount: view.unmount }
}

/** One free time (10:00 Athens) on whatever day is asked. */
function slotsOfTheDay(_businessId: string, query: SlotsQuery): Promise<Slot[]> {
  return Promise.resolve([
    {
      startsAt: `${query.from}T07:00:00+00:00`,
      localDate: query.from,
      localTime: '10:00',
      staffIds: [IDS.nikos],
    },
  ])
}

describe('AppointmentSheet', () => {
  it('a future booking: confirm, move, cancel — no «Ήρθε» before it starts', async () => {
    open(testAppointment())
    expect(await screen.findByText('Γιώργος Π.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Επιβεβαίωση' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Μετακίνηση' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ακύρωση' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Δεν ήρθε' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Κλήση +30 690 000 0001' })).toHaveAttribute(
      'href',
      'tel:+306900000001',
    )
  })

  it('no-show sends the status the sheet showed and closes only after the answer', async () => {
    vi.setSystemTime(Date.parse('2026-09-29T07:40:00Z'))
    calendarApi.setAppointmentStatus.mockResolvedValue({
      appointmentId: IDS.appointment,
      status: 'no_show',
      fromStatus: 'booked',
      changed: true,
    })
    const { onClose } = open(testAppointment())
    fireEvent.click(await screen.findByRole('button', { name: 'Δεν ήρθε' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    const [, input] = calendarApi.setAppointmentStatus.mock.calls[0] as [string, StatusInput]
    expect(input).toMatchObject({
      appointmentId: IDS.appointment,
      fromStatus: 'booked',
      status: 'no_show',
    })
  })

  it('AN021 (changed on another device) is explained, nothing is overwritten', async () => {
    vi.setSystemTime(Date.parse('2026-09-29T07:40:00Z'))
    calendarApi.setAppointmentStatus.mockRejectedValue(
      new RpcFailure({ kind: 'domain', code: 'AN021' }),
    )
    const { onClose } = open(testAppointment())
    fireEvent.click(await screen.findByRole('button', { name: 'Ήρθε' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/άλλαξε στο μεταξύ/)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cancel with a reason; the SMS option only for a future appointment with a phone', async () => {
    calendarApi.cancelAppointment.mockResolvedValue({
      appointmentId: IDS.appointment,
      status: 'cancelled',
      fromStatus: 'booked',
      changed: true,
      cancelledBy: 'client',
      cancelReason: 'client_request',
      notify: true,
      smsQueued: false,
    })
    open(testAppointment())
    fireEvent.click(await screen.findByRole('button', { name: 'Ακύρωση' }))
    expect(screen.getByRole('radio', { name: 'Το ζήτησε ο πελάτης' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Ενημέρωση με SMS/ })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Διπλό ραντεβού' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση ραντεβού' }))

    expect(await screen.findByText('Το ραντεβού ακυρώθηκε')).toBeInTheDocument()
    expect(screen.getByText('Δεν στάλθηκε SMS στον πελάτη.')).toBeInTheDocument()
    const [, input] = calendarApi.cancelAppointment.mock.calls[0] as [string, CancelInput]
    expect(input).toMatchObject({ fromStatus: 'booked', reason: 'duplicate', notify: true })
  })

  it('cancel with SMS that the server queued: «Ο πελάτης θα ενημερωθεί με SMS.»', async () => {
    calendarApi.cancelAppointment.mockResolvedValue({
      appointmentId: IDS.appointment,
      status: 'cancelled',
      fromStatus: 'booked',
      changed: true,
      cancelledBy: 'client',
      cancelReason: 'client_request',
      notify: true,
      smsQueued: true,
    })
    open(testAppointment())
    fireEvent.click(await screen.findByRole('button', { name: 'Ακύρωση' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση ραντεβού' }))

    expect(await screen.findByText('Το ραντεβού ακυρώθηκε')).toBeInTheDocument()
    expect(screen.getByText('Ο πελάτης θα ενημερωθεί με SMS.')).toBeInTheDocument()
    expect(screen.queryByText('Δεν στάλθηκε SMS στον πελάτη.')).toBeNull()
  })

  it('cancel without SMS: no note about SMS at all', async () => {
    calendarApi.cancelAppointment.mockResolvedValue({
      appointmentId: IDS.appointment,
      status: 'cancelled',
      fromStatus: 'booked',
      changed: true,
      cancelledBy: 'client',
      cancelReason: 'client_request',
      notify: false,
      smsQueued: false,
    })
    open(testAppointment())
    fireEvent.click(await screen.findByRole('button', { name: 'Ακύρωση' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Ενημέρωση με SMS/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση ραντεβού' }))

    expect(await screen.findByText('Το ραντεβού ακυρώθηκε')).toBeInTheDocument()
    expect(screen.queryByText('Ο πελάτης θα ενημερωθεί με SMS.')).toBeNull()
    expect(screen.queryByText('Δεν στάλθηκε SMS στον πελάτη.')).toBeNull()
  })

  it('a move with SMS that the server queued says so on the success screen', async () => {
    calendarApi.fetchStaffSlots.mockImplementation(slotsOfTheDay)
    open(
      testAppointment({
        startsAt: '2026-09-29T08:00:00+00:00',
        endsAt: '2026-09-29T08:30:00+00:00',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Μετακίνηση' }))
    const dialog = screen.getByRole('dialog')
    const times = await within(dialog).findByRole('group', { name: /^Ελεύθερες ώρες/ })
    fireEvent.click(within(times).getByRole('button', { name: '10:00' }))
    calendarApi.moveAppointment.mockResolvedValue({
      appointmentId: IDS.appointment,
      staffId: IDS.nikos,
      startsAt: '2026-09-29T07:00:00+00:00',
      endsAt: '2026-09-29T07:30:00+00:00',
      fromStaffId: IDS.nikos,
      fromStartsAt: '2026-09-29T08:00:00+00:00',
      warnings: [],
      replayed: false,
      notify: true,
      smsQueued: true,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Μετακίνηση εδώ' }))
    expect(await screen.findByRole('img', { name: 'Το ραντεβού μετακινήθηκε' })).toBeInTheDocument()
    expect(screen.getByText('Ο πελάτης θα ενημερωθεί με SMS.')).toBeInTheDocument()
  })

  it('a status answer that comes after the sheet closed does not close another sheet', async () => {
    vi.setSystemTime(Date.parse('2026-09-29T07:40:00Z'))
    let answer: (value: StatusResult) => void = () => {}
    calendarApi.setAppointmentStatus.mockImplementation(
      () => new Promise<StatusResult>((resolve) => (answer = resolve)),
    )
    const { onClose, unmount } = open(testAppointment())
    fireEvent.click(await screen.findByRole('button', { name: 'Ήρθε' }))
    expect(await screen.findByRole('button', { name: 'Αποθήκευση…' })).toBeDisabled()

    // Closed with X while saving; by now the page may show quick add or another appointment.
    unmount()
    await act(() =>
      Promise.resolve(
        answer({
          appointmentId: IDS.appointment,
          status: 'completed',
          fromStatus: 'booked',
          changed: true,
        }),
      ),
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cancel again after AN021 sends the status the day shows now, not the one it opened with', async () => {
    const confirmed = testAppointment({ status: 'confirmed' })
    calendarApi.cancelAppointment
      .mockRejectedValueOnce(new RpcFailure({ kind: 'domain', code: 'AN021' }))
      .mockResolvedValueOnce({
        appointmentId: IDS.appointment,
        status: 'cancelled',
        fromStatus: 'confirmed',
        changed: true,
        cancelledBy: 'client',
        cancelReason: 'client_request',
        notify: true,
        smsQueued: false,
      })
    open(testAppointment())
    calendarApi.fetchStaffDay.mockResolvedValue([confirmed])
    fireEvent.click(await screen.findByRole('button', { name: 'Ακύρωση' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση ραντεβού' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/άλλαξε στο μεταξύ/)
    await waitFor(() => expect(calendarApi.fetchStaffDay).toHaveBeenCalledTimes(2))

    // As the AN021 text suggests: the same button again, without leaving the form.
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση ραντεβού' }))
    expect(await screen.findByText('Το ραντεβού ακυρώθηκε')).toBeInTheDocument()
    const inputs = calendarApi.cancelAppointment.mock.calls.map((call) => call[1] as CancelInput)
    expect(inputs.map((input) => input.fromStatus)).toEqual(['booked', 'confirmed'])
  })

  it('cancel after AN021, back and in again: the old error is gone, the current status is sent', async () => {
    const confirmed = testAppointment({ status: 'confirmed' })
    calendarApi.cancelAppointment
      .mockRejectedValueOnce(new RpcFailure({ kind: 'domain', code: 'AN021' }))
      .mockResolvedValueOnce({
        appointmentId: IDS.appointment,
        status: 'cancelled',
        fromStatus: 'confirmed',
        changed: true,
        cancelledBy: 'client',
        cancelReason: 'client_request',
        notify: true,
        smsQueued: false,
      })
    open(testAppointment())
    // Another device confirmed it meanwhile: the refetch after AN021 brings that.
    calendarApi.fetchStaffDay.mockResolvedValue([confirmed])
    fireEvent.click(await screen.findByRole('button', { name: 'Ακύρωση' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση ραντεβού' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/άλλαξε στο μεταξύ/)
    await waitFor(() => expect(calendarApi.fetchStaffDay).toHaveBeenCalledTimes(2))

    // Back and in again: no error of the earlier attempt.
    fireEvent.click(screen.getByRole('button', { name: 'Πίσω' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Ακύρωση' }))
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση ραντεβού' }))
    expect(await screen.findByText('Το ραντεβού ακυρώθηκε')).toBeInTheDocument()
    const inputs = calendarApi.cancelAppointment.mock.calls.map((call) => call[1] as CancelInput)
    expect(inputs.map((input) => input.fromStatus)).toEqual(['booked', 'confirmed'])
  })

  it('a failed refetch of the day keeps the appointment and its actions on screen', async () => {
    const { queryClient } = open(testAppointment())
    expect(await screen.findByText('Γιώργος Π.')).toBeInTheDocument()
    calendarApi.fetchStaffDay.mockRejectedValue(new RpcFailure({ kind: 'offline' }))
    await act(() => queryClient.refetchQueries())
    expect(
      await screen.findByText('Δεν ανανεώθηκε: βλέπεις ό,τι φορτώθηκε τελευταία.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Γιώργος Π.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Επιβεβαίωση' })).toBeInTheDocument()
  })

  it('move: another day drops the time chosen on the previous one', async () => {
    calendarApi.fetchStaffSlots.mockImplementation(slotsOfTheDay)
    open(
      testAppointment({
        startsAt: '2026-09-29T08:00:00+00:00',
        endsAt: '2026-09-29T08:30:00+00:00',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Μετακίνηση' }))
    const dialog = screen.getByRole('dialog')
    const times = await within(dialog).findByRole('group', { name: /^Ελεύθερες ώρες/ })
    fireEvent.click(within(times).getByRole('button', { name: '10:00' }))
    expect(screen.getByRole('button', { name: 'Μετακίνηση εδώ' })).toBeEnabled()

    const wednesday = dialog.querySelector<HTMLButtonElement>('button[data-date="2026-09-30"]')
    if (!wednesday) throw new Error('no 30 September in the strip')
    fireEvent.click(wednesday)
    const next = await within(dialog).findByRole('group', { name: /30 Σεπτεμβρίου/ })
    expect(within(next).getByRole('button', { name: '10:00' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: 'Μετακίνηση εδώ' })).toBeDisabled()

    fireEvent.click(within(next).getByRole('button', { name: '10:00' }))
    calendarApi.moveAppointment.mockResolvedValue({
      appointmentId: IDS.appointment,
      staffId: IDS.nikos,
      startsAt: '2026-09-30T07:00:00+00:00',
      endsAt: '2026-09-30T07:30:00+00:00',
      fromStaffId: IDS.nikos,
      fromStartsAt: '2026-09-29T08:00:00+00:00',
      warnings: [],
      replayed: false,
      notify: true,
      smsQueued: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Μετακίνηση εδώ' }))
    await waitFor(() => expect(calendarApi.moveAppointment).toHaveBeenCalledTimes(1))
    const [, input] = calendarApi.moveAppointment.mock.calls[0] as [string, MoveInput]
    expect(input.newStartsAt).toBe('2026-09-30T07:00:00+00:00')
    expect(await screen.findByRole('img', { name: 'Το ραντεβού μετακινήθηκε' })).toBeInTheDocument()
  })

  it('a client with a Greek landline: no SMS option on cancel, and none is asked for', async () => {
    // No SMS can reach a landline, so the sheet never offers (or promises) one (contract 1.5 §4.5).
    calendarApi.cancelAppointment.mockResolvedValue({
      appointmentId: IDS.appointment,
      status: 'cancelled',
      fromStatus: 'booked',
      changed: true,
      cancelledBy: 'client',
      cancelReason: 'client_request',
      notify: false,
      smsQueued: false,
    })
    open(
      testAppointment({
        client: { id: IDS.client, fullName: 'Λάμπρος Σ.', phoneE164: '+302101234567' },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Ακύρωση' }))
    expect(screen.queryByRole('checkbox', { name: /Ενημέρωση με SMS/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση ραντεβού' }))

    expect(await screen.findByText('Το ραντεβού ακυρώθηκε')).toBeInTheDocument()
    expect(screen.queryByText('Ο πελάτης θα ενημερωθεί με SMS.')).toBeNull()
    const [, input] = calendarApi.cancelAppointment.mock.calls[0] as [string, CancelInput]
    expect(input).toMatchObject({ notify: false })
  })

  it('a walk-in without a phone: no SMS option on cancel', async () => {
    open(testAppointment({ client: null, clientId: null, source: 'walkin' }))
    expect(await screen.findByText('Walk-in χωρίς όνομα')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Καρτέλα πελάτη' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ακύρωση' }))
    expect(screen.queryByRole('checkbox', { name: /Ενημέρωση με SMS/ })).toBeNull()
  })

  it('links to the client card when there is a client (contract 1.8 §4.10)', async () => {
    open(testAppointment())
    const link = await screen.findByRole('link', { name: 'Καρτέλα πελάτη' })
    expect(link).toHaveAttribute('href', `/clients/${IDS.client}`)
  })

  it('an erased client (no client on the row): «Walk-in χωρίς όνομα» and no card link', async () => {
    open(testAppointment({ client: null }))
    expect(await screen.findByText('Walk-in χωρίς όνομα')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Καρτέλα πελάτη' })).toBeNull()
  })
})
