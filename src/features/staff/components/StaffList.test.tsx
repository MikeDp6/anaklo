import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { useStaff } from '../hooks/useStaff'
import type { StaffMember, StaffOrder } from '../schema'
import { StaffList } from './StaffList'

const api = vi.hoisted(() => ({
  fetchStaff: vi.fn<(businessId: string) => Promise<StaffMember[]>>(),
  setStaffOrder: vi.fn<(businessId: string, ids: readonly string[]) => Promise<StaffOrder>>(),
  createStaff: vi.fn(),
  updateStaff: vi.fn(),
}))
vi.mock('../api', () => api)

// Test data only (synthetic ids and names).
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const A: StaffMember = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Σταύρος',
  color: '#2F6B5E',
  sort: 0,
  active: true,
}
const B: StaffMember = {
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Μάριος',
  color: null,
  sort: 1,
  active: false,
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

/** The list as StaffPage feeds it: from the staff query. */
function Harness({ onOpen }: { onOpen: (member: StaffMember) => void }) {
  const staff = useStaff(BUSINESS)
  return staff.data ? <StaffList businessId={BUSINESS} staff={staff.data} onOpen={onOpen} /> : null
}

function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  const onOpen = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Harness onOpen={onOpen} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpen }
}

function names(): string[] {
  return within(screen.getByTestId('staff-list'))
    .getAllByRole('button', { name: /^Επεξεργασία: / })
    .map((button) => button.getAttribute('aria-label')?.replace('Επεξεργασία: ', '') ?? '')
}

describe('StaffList (contract 1.6 §4.4)', () => {
  it('the order changes only after set_staff_order answered', async () => {
    api.fetchStaff.mockResolvedValueOnce([A, B]).mockResolvedValue([
      { ...B, sort: 0 },
      { ...A, sort: 1 },
    ])
    let answer: (order: StaffOrder) => void = () => {}
    api.setStaffOrder.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    open()
    await waitFor(() => expect(names()).toEqual(['Σταύρος', 'Μάριος']))

    fireEvent.click(screen.getByRole('button', { name: 'Μετακίνηση πάνω: Μάριος' }))
    expect(await screen.findByText('Αποθήκευση σειράς…')).toBeInTheDocument()
    expect(api.setStaffOrder).toHaveBeenCalledWith(BUSINESS, [B.id, A.id])
    // Pending: still the old order, and no other reorder can start.
    expect(names()).toEqual(['Σταύρος', 'Μάριος'])
    expect(screen.getByRole('button', { name: 'Μετακίνηση κάτω: Σταύρος' })).toBeDisabled()

    answer([
      { id: B.id, sort: 0 },
      { id: A.id, sort: 1 },
    ])
    await waitFor(() => expect(names()).toEqual(['Μάριος', 'Σταύρος']))
  })

  it('the arrows stop at the ends; «Ωράριο» leads to that staff member’s hours; inactive marked', async () => {
    api.fetchStaff.mockResolvedValue([A, B])
    const { onOpen } = open()
    await waitFor(() => expect(names()).toEqual(['Σταύρος', 'Μάριος']))
    expect(screen.getByRole('button', { name: 'Μετακίνηση πάνω: Σταύρος' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Μετακίνηση κάτω: Μάριος' })).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Ωράριο: Μάριος' })).toHaveAttribute(
      'href',
      `/settings/hours?staff=${B.id}`,
    )
    expect(screen.getByText('Ανενεργός')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Επεξεργασία: Σταύρος' }))
    expect(onOpen).toHaveBeenCalledWith(A)
  })
})
