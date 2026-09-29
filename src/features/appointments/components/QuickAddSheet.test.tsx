import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookInput, BookResult, Slot } from '@/features/calendar/schema'
import type { QuickAddPreset } from '../hooks/useQuickAddFlow'
import type { SlotsQuery } from '@/shared/lib/proQueryKeys'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import { IDS, testWorkspace } from '../testFixtures'
import { QuickAddSheet } from './QuickAddSheet'

const calendarApi = vi.hoisted(() => ({
  fetchStaffSlots: vi.fn(),
  bookAppointment: vi.fn(),
  fetchDayFrame: vi.fn(),
  fetchStaffDay: vi.fn(),
  fetchTodaySummary: vi.fn(),
  setAppointmentStatus: vi.fn(),
  cancelAppointment: vi.fn(),
  moveAppointment: vi.fn(),
  localDayBounds: vi.fn(),
}))
vi.mock('@/features/calendar/api', () => calendarApi)

const clientsApi = vi.hoisted(() => ({ searchClients: vi.fn() }))
vi.mock('@/features/clients/api', () => clientsApi)

const TODAY = '2026-09-29'
const TEN = '2026-09-29T07:00:00+00:00' // 10:00 in Athens
const BOOKED: BookResult = {
  appointmentId: IDS.appointment,
  staffId: IDS.nikos,
  startsAt: TEN,
  endsAt: '2026-09-29T07:30:00+00:00',
  totalCents: 1300,
  replayed: false,
  warnings: [],
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
  calendarApi.fetchStaffSlots.mockResolvedValue([
    { startsAt: TEN, localDate: TODAY, localTime: '10:00', staffIds: [IDS.nikos] },
    {
      startsAt: '2026-09-29T07:15:00+00:00',
      localDate: TODAY,
      localTime: '10:15',
      staffIds: [IDS.nikos],
    },
  ])
  clientsApi.searchClients.mockResolvedValue([
    { id: IDS.client, fullName: 'Γιώργος Π.', phoneE164: '+306900000001', lastVisitAt: null },
  ])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function open(preset?: QuickAddPreset) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <QuickAddSheet workspace={testWorkspace()} today={TODAY} preset={preset} onClose={onClose} />
    </QueryClientProvider>,
  )
  return { onClose }
}

async function pickExistingClientServiceAndTime() {
  fireEvent.change(screen.getByLabelText('Αναζήτηση πελάτη'), { target: { value: 'γιω' } })
  fireEvent.click(await screen.findByRole('button', { name: /Γιώργος Π\./ }))
  fireEvent.click(await screen.findByRole('button', { name: /^Κούρεμα/ }))
  // Staff preselected: the owner's own staff row.
  expect(await screen.findByRole('button', { name: /Νίκος/, pressed: true })).toBeInTheDocument()
  const times = await screen.findByRole('group', { name: /^Ελεύθερες ώρες/ })
  fireEvent.click(within(times).getByRole('button', { name: '10:00' }))
}

/** 10:00 and 10:15 (Athens) on whatever day is asked. */
function slotsOfTheDay(_businessId: string, query: SlotsQuery): Promise<Slot[]> {
  return Promise.resolve(
    ['07:00', '07:15'].map((utc, index) => ({
      startsAt: `${query.from}T${utc}:00+00:00`,
      localDate: query.from,
      localTime: index === 0 ? '10:00' : '10:15',
      staffIds: [IDS.nikos],
    })),
  )
}

function dayButton(date: string): HTMLButtonElement {
  const button = screen
    .getByRole('dialog')
    .querySelector<HTMLButtonElement>(`button[data-date="${date}"]`)
  if (!button) throw new Error(`no ${date} in the strip`)
  return button
}

function bookButton() {
  return screen.getByRole('button', { name: 'Κλείσε το ραντεβού' })
}

describe('QuickAddSheet (phone booking, one round trip)', () => {
  it('search → service → time → one booking call; success only after the answer', async () => {
    let answer: (value: BookResult) => void = () => {}
    calendarApi.bookAppointment.mockImplementation(
      () => new Promise<BookResult>((resolve) => (answer = resolve)),
    )
    open()
    await pickExistingClientServiceAndTime()
    fireEvent.click(bookButton())

    await waitFor(() => expect(calendarApi.bookAppointment).toHaveBeenCalledTimes(1))
    const [businessId, input] = calendarApi.bookAppointment.mock.calls[0] as [string, BookInput]
    expect(businessId).toBe(IDS.business)
    expect(input).toMatchObject({
      serviceIds: [IDS.cut],
      staffId: IDS.nikos,
      startsAt: TEN,
      source: 'phone',
      allowOutsideHours: false,
      allowBufferOverlap: false,
      client: { kind: 'existing', clientId: IDS.client },
    })
    expect(input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    // Pending: no success yet.
    expect(screen.getByRole('button', { name: 'Κράτηση…' })).toBeDisabled()
    expect(screen.queryByText('Το ραντεβού κλείστηκε')).toBeNull()

    answer(BOOKED)
    expect(await screen.findByRole('img', { name: 'Το ραντεβού κλείστηκε' })).toBeInTheDocument()
    expect(
      screen.getByText(/Γιώργος Π\. · Τρίτη 29 Σεπτεμβρίου στις 10:00 · Νίκος/),
    ).toBeInTheDocument()
  })

  it('offline: the form locks; «Δοκίμασε ξανά» resends the same key', async () => {
    calendarApi.bookAppointment
      .mockRejectedValueOnce(new RpcFailure({ kind: 'offline' }))
      .mockResolvedValueOnce({ ...BOOKED, replayed: true })
    open()
    await pickExistingClientServiceAndTime()
    fireEvent.click(bookButton())

    expect(await screen.findByText('Δεν αποθηκεύτηκε — χωρίς σύνδεση')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Κλείσε το ραντεβού' })).toBeNull()
    expect(screen.getByRole('button', { name: '10:15' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Δοκίμασε ξανά' }))
    expect(await screen.findByRole('img', { name: 'Το ραντεβού κλείστηκε' })).toBeInTheDocument()
    const [first, second] = calendarApi.bookAppointment.mock.calls.map(
      (call) => call[1] as BookInput,
    )
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey)
    expect(second).toEqual(first)
  })

  it('a new client inline: name and mobile, sent in E.164 in the same call', async () => {
    calendarApi.bookAppointment.mockResolvedValue(BOOKED)
    open()
    fireEvent.change(screen.getByLabelText('Αναζήτηση πελάτη'), {
      target: { value: 'Νέος Πελάτης' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Νέος πελάτης' }))
    expect(screen.getByLabelText('Ονοματεπώνυμο')).toHaveValue('Νέος Πελάτης')
    fireEvent.change(screen.getByLabelText('Κινητό'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Συνέχεια' }))
    expect(await screen.findByText('Γράψε ένα σωστό κινητό ή άφησέ το κενό.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Κινητό'), { target: { value: '6900000999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Συνέχεια' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Κούρεμα/ }))
    const times = await screen.findByRole('group', { name: /^Ελεύθερες ώρες/ })
    fireEvent.click(within(times).getByRole('button', { name: '10:00' }))
    fireEvent.click(bookButton())

    await waitFor(() => expect(calendarApi.bookAppointment).toHaveBeenCalledTimes(1))
    expect((calendarApi.bookAppointment.mock.calls[0] as [string, BookInput])[1].client).toEqual({
      kind: 'new',
      fullName: 'Νέος Πελάτης',
      phoneE164: '+306900000999',
      locale: 'el',
    })
  })

  it('another day drops the time chosen on the previous one: nothing is booked off screen', async () => {
    calendarApi.fetchStaffSlots.mockImplementation(slotsOfTheDay)
    calendarApi.bookAppointment.mockResolvedValue({
      ...BOOKED,
      startsAt: '2026-09-30T07:15:00+00:00',
    })
    open()
    await pickExistingClientServiceAndTime()
    expect(bookButton()).toBeEnabled()

    fireEvent.click(dayButton('2026-09-30'))
    const times = await screen.findByRole('group', { name: /30 Σεπτεμβρίου/ })
    expect(within(times).getByRole('button', { name: '10:00' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(bookButton()).toBeDisabled()

    fireEvent.click(within(times).getByRole('button', { name: '10:15' }))
    fireEvent.click(bookButton())
    await waitFor(() => expect(calendarApi.bookAppointment).toHaveBeenCalledTimes(1))
    const [, input] = calendarApi.bookAppointment.mock.calls[0] as [string, BookInput]
    expect(input.startsAt).toBe('2026-09-30T07:15:00+00:00')
  })

  it('a gap that starts off the grid (10:40) names its time; another day drops it', async () => {
    calendarApi.fetchStaffSlots.mockImplementation(slotsOfTheDay)
    open({ staffId: IDS.nikos, startsAt: '2026-09-29T07:40:00+00:00' })
    fireEvent.change(screen.getByLabelText('Αναζήτηση πελάτη'), { target: { value: 'γιω' } })
    fireEvent.click(await screen.findByRole('button', { name: /Γιώργος Π./ }))
    fireEvent.click(await screen.findByRole('button', { name: /^Κούρεμα/ }))

    expect(await screen.findByText('Επιλεγμένη ώρα: 10:40')).toBeInTheDocument()
    expect(bookButton()).toBeEnabled()

    fireEvent.click(dayButton('2026-09-30'))
    await screen.findByRole('group', { name: /30 Σεπτεμβρίου/ })
    expect(screen.queryByText(/Επιλεγμένη ώρα/)).toBeNull()
    expect(bookButton()).toBeDisabled()
  })

  it('each new step takes the focus (the tapped control left with the old one)', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Αναζήτηση πελάτη'), { target: { value: 'γιω' } })
    const client = await screen.findByRole('button', { name: /Γιώργος Π./ })
    client.focus()
    fireEvent.click(client)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Υπηρεσία' })),
    )

    const service = await screen.findByRole('button', { name: /^Κούρεμα/ })
    service.focus()
    fireEvent.click(service)
    await waitFor(() =>
      // The step (the outer group; its fieldset inside has the same name).
      expect(document.activeElement).toBe(
        screen.getAllByRole('group', { name: 'Επαγγελματίας και ώρα' })[0],
      ),
    )
  })

  it('an emptied search box lists nothing (not the results of the earlier query)', async () => {
    open()
    const box = screen.getByLabelText('Αναζήτηση πελάτη')
    expect(box).toHaveAttribute('maxLength', '100')
    fireEvent.change(box, { target: { value: 'γιω' } })
    expect(await screen.findByRole('button', { name: /Γιώργος Π./ })).toBeInTheDocument()

    fireEvent.change(box, { target: { value: '' } })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Γιώργος Π./ })).toBeNull())
    fireEvent.change(box, { target: { value: 'γ' } })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryByRole('button', { name: /Γιώργος Π./ })).toBeNull()
  })
})
