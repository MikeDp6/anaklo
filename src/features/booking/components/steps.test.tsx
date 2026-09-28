import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { bookingCatalogues } from '@/shared/i18n/booking'
import { initialBookingState, type BookingState } from '../flow/bookingReducer'
import type { BookingFlow } from '../flow/useBookingFlow'
import type { Catalogue, CatalogueStaff } from '../schema'
import { ServiceStep } from './ServiceStep'
import { StaffStep } from './StaffStep'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CUT = id(301)

function member(n: number, name: string): CatalogueStaff {
  return {
    id: id(100 + n),
    display_name: name,
    color: n === 1 ? '#C8A15A' : null,
    sort: n,
    services: [{ service_id: CUT, duration_min: 30 + n, price_cents: 1300 }],
  }
}

function catalogue(staff: CatalogueStaff[], allowAny = true): Catalogue {
  return {
    business: {
      id: id(1),
      slug: 'demo-barber',
      name: 'Demo Barber',
      vertical: 'barber',
      timezone: 'Europe/Athens',
      locale: 'el',
      currency: 'EUR',
      theme: {},
      address: null,
      maps_url: null,
      phone_e164: null,
      min_notice_min: 60,
      max_advance_days: 60,
      allow_any_staff: allowAny,
    },
    categories: [{ id: id(201), name: 'Μαλλιά', sort: 0 }],
    services: [
      {
        id: CUT,
        category_id: id(201),
        name: 'Κούρεμα',
        duration_min: 30,
        price_cents: 1300,
        sort: 0,
      },
    ],
    staff,
  }
}

function flow(data: Catalogue, state: Partial<BookingState> = {}): BookingFlow {
  return {
    catalogue: data,
    state: { ...initialBookingState(), ...state },
    dispatch: vi.fn(),
    locale: 'el',
  }
}

beforeAll(async () => {
  await initI18n(bookingCatalogues)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ServiceStep', () => {
  it('lists the services by category with duration and price; a tap chooses one', () => {
    const f = flow(catalogue([member(1, 'Νίκος'), member(2, 'Άλεξ')]))
    render(<ServiceStep flow={f} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Τι θα κάνουμε;' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Μαλλιά' })).toBeInTheDocument()
    const service = screen.getByRole('button', { name: /Κούρεμα/ })
    expect(service).toHaveTextContent('30′ · 13,00 €')
    service.click()
    expect(f.dispatch).toHaveBeenCalledWith({
      type: 'service',
      serviceId: CUT,
      staffStep: true,
      staffId: null,
    })
  })

  it('enters with E14 only after a step change (the first screen has its own entrances)', () => {
    const { container, rerender } = render(<ServiceStep flow={flow(catalogue([]))} />)
    expect(container.querySelector('section')).not.toHaveClass('step-enter')
    rerender(<ServiceStep flow={flow(catalogue([]), { direction: 'back' })} />)
    expect(container.querySelector('section')).toHaveClass('step-enter-back')
  })
})

describe('StaffStep', () => {
  it('lists «anyone» first and each member with their own terms', () => {
    const f = flow(catalogue([member(1, 'Νίκος'), member(2, 'Άλεξ')]), { serviceId: CUT })
    render(<StaffStep flow={f} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]).toHaveTextContent('Οποιοσδήποτε')
    expect(screen.getByRole('button', { name: /Άλεξ/ })).toHaveTextContent('32′ · 13,00 €')
    expect(screen.queryByRole('button', { name: 'Επόμενοι' })).toBeNull()
    screen.getByRole('button', { name: /Οποιοσδήποτε/ }).click()
    expect(f.dispatch).toHaveBeenCalledWith({ type: 'staff', staffId: null })
  })

  it('offers no «anyone» when the business does not allow it', () => {
    render(
      <StaffStep
        flow={flow(catalogue([member(1, 'Νίκος'), member(2, 'Άλεξ')], false), { serviceId: CUT })}
      />,
    )
    expect(screen.queryByRole('button', { name: /Οποιοσδήποτε/ })).toBeNull()
  })

  it('turns into the E12 carousel with more than four staff members', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const staff = ['Νίκος', 'Άλεξ', 'Μάκης', 'Σάκης', 'Τάκης'].map((name, n) => member(n + 1, name))
    render(<StaffStep flow={flow(catalogue(staff), { serviceId: CUT })} />)
    expect(screen.getByRole('button', { name: 'Προηγούμενοι' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Επόμενοι' })).toBeEnabled()
    expect(screen.getByRole('img', { name: '1 από 5' })).toBeInTheDocument()
  })
})
