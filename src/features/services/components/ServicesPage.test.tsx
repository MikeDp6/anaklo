import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMBER_ROUTE_ID, type MemberContext } from '@/features/auth/loaders'
import type { Business } from '@/features/settings/schema'
import type { StaffMember } from '@/features/staff/schema'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { CatalogueService, Category } from '../schema'
import { ServicesPage } from './ServicesPage'

const servicesApi = vi.hoisted(() => ({
  fetchServices: vi.fn(),
  fetchServiceCatalogue: vi.fn<() => Promise<CatalogueService[]>>(),
  fetchCategories: vi.fn<() => Promise<Category[]>>(),
  saveService: vi.fn(),
}))
vi.mock('../api', () => servicesApi)
const staffApi = vi.hoisted(() => ({ fetchStaff: vi.fn<() => Promise<StaffMember[]>>() }))
vi.mock('@/features/staff/api', () => staffApi)
const settingsApi = vi.hoisted(() => ({ fetchBusiness: vi.fn<() => Promise<Business>>() }))
vi.mock('@/features/settings/api', () => settingsApi)

// Test data only (synthetic ids and names).
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const HAIR: Category = { id: '00000000-0000-4000-8000-000000000201', name: 'Μαλλιά', sort: 0 }
const STAFF: StaffMember = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Σταύρος',
  color: null,
  sort: 0,
  active: true,
}

function service(overrides: Partial<CatalogueService> & { name: string }): CatalogueService {
  return {
    id: `00000000-0000-4000-8000-00000000030${overrides.sort ?? 0}`,
    categoryId: HAIR.id,
    durationMin: 30,
    bufferAfterMin: 0,
    priceCents: 1300,
    onlineBookable: true,
    active: true,
    sort: 0,
    offers: [{ staffId: STAFF.id, customDurationMin: null, customPriceCents: null }],
    ...overrides,
  }
}

const OWNER: MemberContext = {
  user: { userId: '00000000-0000-4000-8000-00000000a001', email: 'owner@example.test' },
  membership: { businessId: BUSINESS, role: 'owner', staffId: null },
  memberships: [{ businessId: BUSINESS, role: 'owner', staffId: null }],
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
  settingsApi.fetchBusiness.mockResolvedValue({
    id: BUSINESS,
    name: 'Demo',
    timeZone: 'Europe/Athens',
    currency: 'EUR',
    locale: 'el',
    slotStepMin: 15,
    correctionWindowDays: 3,
  })
  staffApi.fetchStaff.mockResolvedValue([STAFF])
  servicesApi.fetchCategories.mockResolvedValue([HAIR])
  servicesApi.fetchServiceCatalogue.mockResolvedValue([
    service({ name: 'Κούρεμα', sort: 0 }),
    service({
      name: 'Χρώμα γενιών',
      sort: 1,
      durationMin: 20,
      priceCents: 900,
      onlineBookable: false,
    }),
    service({ name: 'Παλιό', sort: 2, active: false }),
  ])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function open() {
  const router = createMemoryRouter(
    [
      {
        id: MEMBER_ROUTE_ID,
        loader: () => OWNER,
        hydrateFallbackElement: <p>loading</p>,
        children: [{ path: 'settings/services', element: <ServicesPage /> }],
      },
    ],
    { initialEntries: ['/settings/services'] },
  )
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('ServicesPage (contract 1.6 §4.3)', () => {
  it('the catalogue by category, with «Μόνο στο κατάστημα» and «Ανενεργές» last', async () => {
    open()
    expect(await screen.findByRole('heading', { level: 1, name: 'Υπηρεσίες' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Πίσω στις ρυθμίσεις' })).toHaveAttribute(
      'href',
      '/settings',
    )
    const list = await screen.findByTestId('service-list')
    const hair = within(list).getByRole('region', { name: 'Μαλλιά' })
    expect(within(hair).getByRole('button', { name: /^Κούρεμα/ })).toHaveTextContent(
      /30′ · 13,00\s€/,
    )
    expect(within(hair).getByRole('button', { name: /^Χρώμα γενιών/ })).toHaveTextContent(
      'Μόνο στο κατάστημα',
    )
    expect(
      within(within(list).getByRole('region', { name: 'Ανενεργές' })).getByText('Παλιό'),
    ).toBeInTheDocument()
  })

  it('«Νέα υπηρεσία» opens an empty sheet; a row opens its own', async () => {
    open()
    await screen.findByTestId('service-list')
    fireEvent.click(screen.getByRole('button', { name: 'Νέα υπηρεσία' }))
    const sheet = screen.getByRole('dialog', { name: 'Νέα υπηρεσία' })
    expect(within(sheet).getByLabelText<HTMLInputElement>('Όνομα').value).toBe('')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Κλείσιμο' }))

    fireEvent.click(screen.getByRole('button', { name: /^Κούρεμα/ }))
    const edit = screen.getByRole('dialog', { name: 'Επεξεργασία υπηρεσίας' })
    expect(within(edit).getByLabelText<HTMLInputElement>('Τιμή').value).toBe('13,00')
    expect(within(edit).getByRole('switch', { name: 'Ενεργή' })).toBeChecked()
  })
})
