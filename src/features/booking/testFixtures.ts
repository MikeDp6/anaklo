import { vi } from 'vitest'
import type { ManageViewResponse } from '@fn-shared/booking-schemas.ts'
import { initialBookingState, type BookingState } from './flow/bookingReducer'
import type { BookingFlow } from './flow/useBookingFlow'
import type { Catalogue, CatalogueStaff, Slot } from './schema'

/** Test data of the booking page (Vitest only): a demo shop in Europe/Athens. */

export const testId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const CUT = testId(301)

export function testMember(n: number, name: string): CatalogueStaff {
  return {
    id: testId(100 + n),
    display_name: name,
    color: n === 1 ? '#C8A15A' : null,
    sort: n,
    services: [{ service_id: CUT, duration_min: 30 + n, price_cents: 1300 }],
  }
}

export function testCatalogue(
  staff: CatalogueStaff[] = [testMember(1, 'Νίκος')],
  allowAny = true,
): Catalogue {
  return {
    business: {
      id: testId(1),
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
    categories: [{ id: testId(201), name: 'Μαλλιά', sort: 0 }],
    services: [
      {
        id: CUT,
        category_id: testId(201),
        name: 'Κούρεμα',
        duration_min: 30,
        price_cents: 1300,
        sort: 0,
      },
    ],
    staff,
  }
}

export function testFlow(data: Catalogue, state: Partial<BookingState> = {}): BookingFlow {
  return {
    catalogue: data,
    state: { ...initialBookingState(), ...state },
    dispatch: vi.fn(),
    locale: 'el',
  }
}

/** Thu 1 Oct 2026, 09:00 in Athens. */
export const TEST_SLOT: Slot = {
  starts_at: '2026-10-01T06:00:00+00:00',
  local_date: '2026-10-01',
  local_time: '09:00:00',
  staff_ids: [testId(101)],
}

/** The manage view of a booked appointment (TEST_SLOT, Νίκος, Κούρεμα). */
export function testManageView(
  appointment: Partial<ManageViewResponse['appointment']> = {},
): ManageViewResponse {
  return {
    business: {
      id: testId(1),
      slug: 'demo-barber',
      name: 'Demo Barber',
      timezone: 'Europe/Athens',
      locale: 'el',
      currency: 'EUR',
      phone_e164: '+302610000000',
      address: null,
      maps_url: null,
      theme: {},
    },
    appointment: {
      id: testId(501),
      status: 'booked',
      starts_at: TEST_SLOT.starts_at,
      ends_at: '2026-10-01T06:30:00+00:00',
      total_cents: 1300,
      staff: { id: testId(101), display_name: 'Νίκος' },
      services: [{ id: CUT, name: 'Κούρεμα', duration_min: 30, price_cents: 1300 }],
      ...appointment,
    },
    change_until: '2026-10-01T04:00:00+00:00',
    can_cancel: true,
    can_reschedule: true,
  }
}
