import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { WeekHoursResult, WeekRow } from '../schema'
import { WeekHoursEditor } from './WeekHoursEditor'

const api = vi.hoisted(() => ({
  replaceWeekHours:
    vi.fn<
      (businessId: string, staffId: string, rows: readonly WeekRow[]) => Promise<WeekHoursResult>
    >(),
  fetchWeekHours: vi.fn(),
  fetchStaff: vi.fn(),
}))
vi.mock('../api', () => api)

// Test data only (synthetic ids).
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const STAFF = '00000000-0000-4000-8000-000000000101'
const TUESDAY: WeekRow[] = [{ weekday: 2, startTime: '10:00', endTime: '18:00' }]

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
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function open(rows: readonly WeekRow[] = TUESDAY) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WeekHoursEditor businessId={BUSINESS} staffId={STAFF} rows={rows} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function answerWith(conflictCount: number) {
  api.replaceWeekHours.mockImplementation((_businessId, staffId, rows) =>
    Promise.resolve({ staffId, changed: true, rows, conflictCount }),
  )
}

const time = (label: string) => screen.getByLabelText<HTMLInputElement>(label)

describe('WeekHoursEditor (contract 1.6 §4.5)', () => {
  it('a split shift: a second interval on Tuesday, both saved in one call', async () => {
    answerWith(0)
    open()
    expect(time('Τρίτη, διάστημα 1: από').value).toBe('10:00')
    expect(screen.getAllByText('Κλειστό')).toHaveLength(6)

    fireEvent.change(time('Τρίτη, διάστημα 1: από'), { target: { value: '09:00' } })
    fireEvent.change(time('Τρίτη, διάστημα 1: έως'), { target: { value: '14:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Προσθήκη διαστήματος: Τρίτη' }))
    // Prefilled after the first one; the owner sets the evening shift.
    expect(time('Τρίτη, διάστημα 2: από').value).toBe('14:00')
    fireEvent.change(time('Τρίτη, διάστημα 2: από'), { target: { value: '17:00' } })
    fireEvent.change(time('Τρίτη, διάστημα 2: έως'), { target: { value: '21:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))

    expect(await screen.findByText('Το ωράριο αποθηκεύτηκε')).toBeInTheDocument()
    expect(api.replaceWeekHours).toHaveBeenCalledTimes(1)
    expect(api.replaceWeekHours.mock.calls[0]).toEqual([
      BUSINESS,
      STAFF,
      [
        { weekday: 2, startTime: '09:00', endTime: '14:00' },
        { weekday: 2, startTime: '17:00', endTime: '21:00' },
      ],
    ])
  })

  it('«Αντιγραφή σε όλες τις μέρες» fills the closed days too; nothing is saved before «Αποθήκευση»', async () => {
    answerWith(0)
    open()
    fireEvent.click(
      screen.getByRole('button', { name: 'Αντιγραφή του ωραρίου: Τρίτη σε όλες τις μέρες' }),
    )
    expect(screen.queryByText('Κλειστό')).toBeNull()
    for (const day of ['Δευτέρα', 'Σάββατο', 'Κυριακή']) {
      expect(time(`${day}, διάστημα 1: από`).value).toBe('10:00')
      expect(time(`${day}, διάστημα 1: έως`).value).toBe('18:00')
    }
    expect(screen.getByRole('status')).toHaveTextContent('Αντιγράφηκε σε όλες τις μέρες')
    expect(api.replaceWeekHours).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    await screen.findByText('Το ωράριο αποθηκεύτηκε')
    const rows = api.replaceWeekHours.mock.calls[0]?.[2] ?? []
    expect(rows.map((row) => row.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('appointments outside the new hours: the count and a link to them', async () => {
    answerWith(2)
    open()
    fireEvent.change(time('Τρίτη, διάστημα 1: έως'), { target: { value: '12:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    expect(await screen.findByText('2 ραντεβού είναι εκτός του νέου ωραρίου.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Δες τα ραντεβού' })).toHaveAttribute(
      'href',
      `/settings/conflicts?staff=${STAFF}`,
    )
  })

  it('an overlap the form missed (23P01) is explained; an overlap it sees is never sent', async () => {
    api.replaceWeekHours.mockRejectedValueOnce(new RpcFailure({ kind: 'overlap' }))
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    expect(
      await screen.findByText('Δύο διαστήματα της ίδιας μέρας επικαλύπτονται.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Προσθήκη διαστήματος: Τρίτη' }))
    fireEvent.change(time('Τρίτη, διάστημα 2: από'), { target: { value: '12:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    expect(
      await screen.findAllByText('Δύο διαστήματα της ίδιας μέρας επικαλύπτονται.'),
    ).not.toHaveLength(0)
    expect(api.replaceWeekHours).toHaveBeenCalledTimes(1)
  })
})
