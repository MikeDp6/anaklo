import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@/features/staff/schema'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { SaveServiceInput, SaveServiceResult } from '../schema'
import { ServiceSheet } from './ServiceSheet'

const api = vi.hoisted(() => ({
  saveService: vi.fn<(businessId: string, input: SaveServiceInput) => Promise<SaveServiceResult>>(),
  fetchServices: vi.fn(),
  fetchServiceCatalogue: vi.fn(),
  fetchCategories: vi.fn(),
}))
vi.mock('../api', () => api)

// Test data only (synthetic ids and names).
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const NEW_ID = '4f1c1e9a-7d0e-4c1b-9a51-2f3e8d7c6b5a'
const STAFF: StaffMember[] = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    displayName: 'Ε2Ε Α',
    color: null,
    sort: 0,
    active: true,
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    displayName: 'Ε2Ε Β',
    color: null,
    sort: 1,
    active: true,
  },
]

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

function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ServiceSheet
        businessId={BUSINESS}
        target={{ kind: 'new', id: NEW_ID }}
        categories={[{ id: '00000000-0000-4000-8000-000000000201', name: 'Μαλλιά', sort: 0 }]}
        staff={STAFF}
        currency="EUR"
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
  return { onClose }
}

function fillNewService() {
  fireEvent.change(screen.getByLabelText('Όνομα'), { target: { value: 'Ε2Ε Ξύρισμα' } })
  fireEvent.change(screen.getByLabelText('Διάρκεια (λεπτά)'), { target: { value: '25' } })
  fireEvent.change(screen.getByLabelText('Τιμή'), { target: { value: '11,00' } })
  fireEvent.change(screen.getByLabelText('Ε2Ε Β: δική του διάρκεια (λεπτά)'), {
    target: { value: '30' },
  })
  fireEvent.change(screen.getByLabelText('Ε2Ε Β: δική του τιμή'), { target: { value: '12' } })
}

function savedResult(input: SaveServiceInput): SaveServiceResult {
  return { ...input, sort: 4, created: true }
}

describe('ServiceSheet (contract 1.6 §4.3, rule 14)', () => {
  it('shows «αποθηκεύτηκε» only after the server answered', async () => {
    let answer: (value: SaveServiceResult) => void = () => {}
    api.saveService.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    open()
    fillNewService()
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    expect(await screen.findByRole('button', { name: 'Αποθήκευση…' })).toBeDisabled()
    expect(screen.queryByText('Η υπηρεσία αποθηκεύτηκε')).toBeNull()

    const [businessId, input] = api.saveService.mock.calls[0] ?? []
    expect(businessId).toBe(BUSINESS)
    expect(input).toEqual({
      id: NEW_ID,
      name: 'Ε2Ε Ξύρισμα',
      categoryId: null,
      durationMin: 25,
      bufferAfterMin: 0,
      priceCents: 1100,
      onlineBookable: true,
      active: true,
      offers: [
        { staffId: STAFF[0]?.id, customDurationMin: null, customPriceCents: null },
        { staffId: STAFF[1]?.id, customDurationMin: 30, customPriceCents: 1200 },
      ],
    })

    if (input) answer(savedResult(input))
    expect(await screen.findByText('Η υπηρεσία αποθηκεύτηκε')).toBeInTheDocument()
    expect(screen.getByText(/Ε2Ε Ξύρισμα · 25′ · 11,00/)).toBeInTheDocument()
  })

  it('after «χωρίς σύνδεση» the form locks; the retry sends the same id and payload', async () => {
    api.saveService
      .mockRejectedValueOnce(new RpcFailure({ kind: 'offline' }))
      .mockImplementationOnce((_businessId, input) => Promise.resolve(savedResult(input)))
    open()
    fillNewService()
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    expect(await screen.findByText('Δεν αποθηκεύτηκε — χωρίς σύνδεση')).toBeInTheDocument()
    expect(screen.getByLabelText('Όνομα')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Αποθήκευση' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Δοκίμασε ξανά' }))
    expect(await screen.findByText('Η υπηρεσία αποθηκεύτηκε')).toBeInTheDocument()
    expect(api.saveService).toHaveBeenCalledTimes(2)
    const [first, second] = api.saveService.mock.calls
    expect(second?.[1]).toEqual(first?.[1])
    expect(second?.[1].id).toBe(NEW_ID)
  })

  it('invalid fields stop the save; nobody checked only warns', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    expect(await screen.findByText('Γράψε όνομα, έως 80 χαρακτήρες.')).toBeInTheDocument()
    expect(screen.getByText('Γράψε τιμή, π.χ. 13,50 (έως 99.999,99).')).toBeInTheDocument()
    expect(api.saveService).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Ε2Ε Α'))
    fireEvent.click(screen.getByLabelText('Ε2Ε Β'))
    await waitFor(() =>
      expect(screen.getByText('Κανείς δεν την κάνει: δεν θα κλείνεται.')).toBeInTheDocument(),
    )
  })

  it('a staff list that changes while the sheet is open never shifts whose checkbox is whose', async () => {
    api.saveService.mockImplementation((_, input) => Promise.resolve(savedResult(input)))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
    })
    const sheet = (staff: StaffMember[]) => (
      <QueryClientProvider client={queryClient}>
        <ServiceSheet
          businessId={BUSINESS}
          target={{ kind: 'new', id: NEW_ID }}
          categories={[]}
          staff={staff}
          currency="EUR"
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(sheet(STAFF))
    // Another device adds «Ε2Ε Γ» first in the order and moves «Ε2Ε Α» last; the list refetches.
    const added: StaffMember = {
      id: '00000000-0000-4000-8000-000000000103',
      displayName: 'Ε2Ε Γ',
      color: null,
      sort: 0,
      active: true,
    }
    rerender(sheet([added, STAFF[1] as StaffMember, STAFF[0] as StaffMember]))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ε2Ε Α' }))
    fireEvent.change(screen.getByLabelText('Όνομα'), { target: { value: 'Ε2Ε Ξύρισμα' } })
    fireEvent.change(screen.getByLabelText('Τιμή'), { target: { value: '11,00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))

    await waitFor(() => expect(api.saveService).toHaveBeenCalledTimes(1))
    // «Ε2Ε Α» unchecked is A's offer gone; B stays; the newcomer is not in this sheet.
    expect(api.saveService.mock.calls[0]?.[1].offers).toEqual([
      { staffId: STAFF[1]?.id, customDurationMin: null, customPriceCents: null },
    ])
    expect(screen.queryByRole('checkbox', { name: 'Ε2Ε Γ' })).toBeNull()
  })
})
