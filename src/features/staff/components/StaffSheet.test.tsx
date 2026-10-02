import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { STAFF_COLORS } from '../colors'
import type { StaffInput, StaffMember } from '../schema'
import { StaffSheet, type StaffSheetTarget } from './StaffSheet'

const api = vi.hoisted(() => ({
  fetchStaff: vi.fn(),
  createStaff:
    vi.fn<(businessId: string, input: StaffInput) => Promise<{ id: string; created: boolean }>>(),
  updateStaff:
    vi.fn<
      (
        businessId: string,
        id: string,
        input: Pick<StaffInput, 'displayName' | 'color' | 'active'>,
      ) => Promise<StaffMember>
    >(),
  setStaffOrder: vi.fn(),
}))
vi.mock('../api', () => api)
const settingsApi = vi.hoisted(() => ({ fetchScheduleConflicts: vi.fn() }))
vi.mock('@/features/settings/api', () => settingsApi)

// Test data only (synthetic ids and names).
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const NEW_ID = '4f1c1e9a-7d0e-4c1b-9a51-2f3e8d7c6b5a'
const A: StaffMember = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Σταύρος',
  color: STAFF_COLORS[0].hex,
  sort: 3,
  active: true,
}

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

function open(target: StaffSheetTarget) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StaffSheet businessId={BUSINESS} target={target} staff={[A]} onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('StaffSheet (contract 1.6 §4.4)', () => {
  it('a new staff member: last in the order, a free colour, saved under the sheet’s id', async () => {
    let answer: (value: { id: string; created: boolean }) => void = () => {}
    api.createStaff.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    open({ kind: 'new', id: NEW_ID })
    expect(screen.queryByRole('switch', { name: 'Ενεργός' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Όνομα'), { target: { value: ' Βοηθός ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    await waitFor(() => expect(api.createStaff).toHaveBeenCalledTimes(1))
    expect(api.createStaff.mock.calls[0]?.[1]).toEqual({
      id: NEW_ID,
      displayName: 'Βοηθός',
      color: STAFF_COLORS[1].hex,
      active: true,
      sort: 4,
    })
    expect(screen.queryByText('Ο επαγγελματίας προστέθηκε')).toBeNull()

    answer({ id: NEW_ID, created: true })
    expect(await screen.findByText('Ο επαγγελματίας προστέθηκε')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ωράριο' })).toHaveAttribute(
      'href',
      `/settings/hours?staff=${NEW_ID}`,
    )
    expect(screen.getByRole('link', { name: 'Υπηρεσίες' })).toHaveAttribute(
      'href',
      '/settings/services',
    )
  })

  it('deactivating warns first, then shows how many future appointments need a change', async () => {
    api.updateStaff.mockImplementation((_businessId, id, input) =>
      Promise.resolve({ ...A, id, ...input }),
    )
    settingsApi.fetchScheduleConflicts.mockResolvedValue([{}, {}])
    open({ kind: 'edit', member: A })
    const active = screen.getByRole('switch', { name: 'Ενεργός' })
    expect(active).toBeChecked()
    fireEvent.click(active)
    expect(
      screen.getByText('Τα μελλοντικά ραντεβού του θα χρειαστούν ανάθεση.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))

    expect(
      await screen.findByText('2 μελλοντικά ραντεβού χρειάζονται ανάθεση.'),
    ).toBeInTheDocument()
    expect(api.updateStaff.mock.calls[0]).toEqual([
      BUSINESS,
      A.id,
      { id: A.id, displayName: 'Σταύρος', color: A.color, active: false, sort: 3 },
    ])
    expect(settingsApi.fetchScheduleConflicts).toHaveBeenCalledWith(
      BUSINESS,
      { staffId: A.id, from: null, to: null },
      expect.anything(),
    )
    expect(screen.getByRole('link', { name: 'Δες τα ραντεβού' })).toHaveAttribute(
      'href',
      `/settings/conflicts?staff=${A.id}`,
    )
  })
})
