import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WeekRow } from '@/features/staff/schema'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { NewException, ScheduleConflict } from '../schema'
import { SETTINGS_IDS as IDS, testConflict, testFrame } from '../testFixtures'
import { ClosureSheet } from './ClosureSheet'

const settingsApi = vi.hoisted(() => ({
  addExceptions: vi.fn<(businessId: string, rows: readonly NewException[]) => Promise<void>>(),
  fetchScheduleConflicts: vi.fn<() => Promise<ScheduleConflict[]>>(),
}))
vi.mock('@/features/settings/api', () => settingsApi)

const staffApi = vi.hoisted(() => ({
  fetchWeekHours: vi.fn<() => Promise<WeekRow[]>>(),
}))
vi.mock('@/features/staff/api', () => staffApi)

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-02T05:00:00Z') })
  // Άλεξ works Fridays 09:00–14:00 and 17:00–21:00.
  staffApi.fetchWeekHours.mockResolvedValue([
    { weekday: 5, startTime: '17:00', endTime: '21:00' },
    { weekday: 5, startTime: '09:00', endTime: '14:00' },
  ])
  settingsApi.fetchScheduleConflicts.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  const onClose = vi.fn()
  const router = createMemoryRouter(
    [
      {
        path: '/settings/closures',
        element: <ClosureSheet frame={testFrame()} today="2026-10-02" onClose={onClose} />,
      },
    ],
    { initialEntries: ['/settings/closures'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { dialog: screen.getByRole('dialog', { name: 'Νέο κλείσιμο' }), onClose }
}

function setDates(dialog: HTMLElement, from: string, to: string) {
  fireEvent.change(within(dialog).getByLabelText('Από'), { target: { value: from } })
  fireEvent.change(within(dialog).getByLabelText('Έως'), { target: { value: to } })
}

describe('ClosureSheet (contract 1.6 §4.6)', () => {
  it('a shop closure: one bulk insert, the note on every row, success only after the answer', async () => {
    let answer: () => void = () => {}
    settingsApi.addExceptions.mockReturnValue(
      new Promise((resolve) => {
        answer = () => resolve()
      }),
    )
    const { dialog } = open()
    setDates(dialog, '2026-12-25', '2026-12-26')
    fireEvent.change(within(dialog).getByLabelText('Σημείωση'), { target: { value: 'Αργία' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))

    await waitFor(() => expect(settingsApi.addExceptions).toHaveBeenCalledTimes(1))
    const rows = settingsApi.addExceptions.mock.calls[0]?.[1] ?? []
    expect(rows.map((row) => [row.localDate, row.kind, row.staffId, row.note])).toEqual([
      ['2026-12-25', 'closed', null, 'Αργία'],
      ['2026-12-26', 'closed', null, 'Αργία'],
    ])
    expect(screen.queryByText('Το κλείσιμο αποθηκεύτηκε.')).toBeNull()
    answer()
    expect(await screen.findByText('Το κλείσιμο αποθηκεύτηκε.')).toBeVisible()
  })

  it('«Ειδικό ωράριο» for a staff member starts from their hours of the first date (D11)', async () => {
    settingsApi.addExceptions.mockResolvedValue()
    const { dialog } = open()
    fireEvent.change(within(dialog).getByLabelText('Για'), { target: { value: IDS.alex } })
    expect(within(dialog).queryByLabelText('Σημείωση')).toBeNull()
    setDates(dialog, '2026-10-09', '2026-10-09') // a Friday
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Ειδικό ωράριο/ }))

    await waitFor(() => expect(within(dialog).getAllByLabelText('Έναρξη')).toHaveLength(2))
    const starts = within(dialog).getAllByLabelText<HTMLInputElement>('Έναρξη')
    const ends = within(dialog).getAllByLabelText<HTMLInputElement>('Λήξη')
    expect(starts.map((input) => input.value)).toEqual(['09:00', '17:00'])
    expect(ends.map((input) => input.value)).toEqual(['14:00', '21:00'])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))
    await waitFor(() => expect(settingsApi.addExceptions).toHaveBeenCalledTimes(1))
    const rows = settingsApi.addExceptions.mock.calls[0]?.[1] ?? []
    expect(
      rows.map((row) => [row.staffId, row.kind, row.startTime, row.endTime, row.note]),
    ).toEqual([
      [IDS.alex, 'open', '09:00', '14:00', null],
      [IDS.alex, 'open', '17:00', '21:00', null],
    ])
  })

  it('with a split shift every time input is named with its interval number', async () => {
    const { dialog } = open()
    fireEvent.change(within(dialog).getByLabelText('Για'), { target: { value: IDS.alex } })
    setDates(dialog, '2026-10-09', '2026-10-09') // a Friday: 09:00–14:00 + 17:00–21:00
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Ειδικό ωράριο/ }))
    await waitFor(() => expect(within(dialog).getAllByLabelText('Έναρξη')).toHaveLength(2))

    const names = Array.from(dialog.querySelectorAll('input[type="time"]'), (input) =>
      input.getAttribute('aria-label'),
    )
    expect(names).toEqual([
      'Διάστημα 1: έναρξη',
      'Διάστημα 1: λήξη',
      'Διάστημα 2: έναρξη',
      'Διάστημα 2: λήξη',
    ])
    expect(within(dialog).getByLabelText<HTMLInputElement>('Διάστημα 2: έναρξη').value).toBe(
      '17:00',
    )
  })

  it('an overlap with an existing closure says so in this screen’s words', async () => {
    settingsApi.addExceptions.mockRejectedValue(new RpcFailure({ kind: 'overlap' }))
    const { dialog } = open()
    setDates(dialog, '2026-12-25', '2026-12-25')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))
    expect(
      await within(dialog).findByText(
        'Υπάρχει ήδη κλείσιμο ή ειδικό ωράριο σε κάποια από αυτές τις μέρες.',
      ),
    ).toBeVisible()
  })

  it('offline: locked; the retry resends the very same rows (same ids)', async () => {
    settingsApi.addExceptions
      .mockRejectedValueOnce(new RpcFailure({ kind: 'offline' }))
      .mockResolvedValueOnce()
    const { dialog } = open()
    setDates(dialog, '2026-12-25', '2026-12-26')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))
    expect(await within(dialog).findByText('Δεν αποθηκεύτηκε — χωρίς σύνδεση')).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: 'Αποθήκευση' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Δοκίμασε ξανά' }))
    expect(await screen.findByText('Το κλείσιμο αποθηκεύτηκε.')).toBeVisible()
    const [first, second] = settingsApi.addExceptions.mock.calls
    expect(second?.[1]).toEqual(first?.[1])
  })

  it('after saving: how many appointments fall in it, with the link to them', async () => {
    settingsApi.addExceptions.mockResolvedValue()
    settingsApi.fetchScheduleConflicts.mockResolvedValue([testConflict()])
    const { dialog } = open()
    setDates(dialog, '2026-12-25', '2026-12-26')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))
    expect(await screen.findByText('1 ραντεβού πέφτει σε αυτό το κλείσιμο.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Δες τα ραντεβού' })).toHaveAttribute(
      'href',
      '/settings/conflicts?from=2026-12-25&to=2026-12-26',
    )
  })
})
