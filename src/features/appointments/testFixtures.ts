import type { Workspace } from '@/features/calendar/hooks/useWorkspace'
import type { DayAppointment } from '@/features/calendar/schema'

/** Synthetic test data of the pro-app Vitest files (the demo shop of the seed). Never bundled. */
export const IDS = {
  business: '00000000-0000-4000-8000-000000000001',
  nikos: '00000000-0000-4000-8000-000000000101',
  alex: '00000000-0000-4000-8000-000000000102',
  cut: '00000000-0000-4000-8000-000000000301',
  beard: '00000000-0000-4000-8000-000000000303',
  client: '00000000-0000-4000-8000-00000000c001',
  appointment: '00000000-0000-4000-8000-00000000d001',
} as const

export function testWorkspace(role: 'owner' | 'manager' | 'staff' = 'owner'): Workspace {
  const staff = [
    { id: IDS.nikos, displayName: 'Νίκος', color: '#C8A15A', sort: 0, active: true },
    { id: IDS.alex, displayName: 'Άλεξ', color: '#4F7CAC', sort: 1, active: true },
  ]
  return {
    membership: {
      businessId: IDS.business,
      role,
      staffId: role === 'manager' ? null : role === 'owner' ? IDS.nikos : IDS.alex,
    },
    businessId: IDS.business,
    business: {
      id: IDS.business,
      name: 'Demo Barber',
      timeZone: 'Europe/Athens',
      currency: 'EUR',
      locale: 'el',
      slotStepMin: 15,
      correctionWindowDays: 3,
    },
    staff,
    activeStaff: staff,
    services: [
      {
        id: IDS.cut,
        name: 'Κούρεμα',
        durationMin: 30,
        bufferAfterMin: 5,
        priceCents: 1300,
        sort: 0,
        offers: [
          { staffId: IDS.nikos, durationMin: 30, priceCents: 1300 },
          { staffId: IDS.alex, durationMin: 35, priceCents: 1300 },
        ],
      },
      {
        id: IDS.beard,
        name: 'Γένια',
        durationMin: 15,
        bufferAfterMin: 0,
        priceCents: 700,
        sort: 1,
        offers: [{ staffId: IDS.nikos, durationMin: 15, priceCents: 700 }],
      },
    ],
  }
}

export function testAppointment(overrides: Partial<DayAppointment> = {}): DayAppointment {
  return {
    id: IDS.appointment,
    staffId: IDS.nikos,
    clientId: IDS.client,
    startsAt: '2026-09-29T07:00:00+00:00',
    endsAt: '2026-09-29T07:30:00+00:00',
    bufferAfterMin: 5,
    status: 'booked',
    source: 'phone',
    totalCents: 1300,
    cancelReason: null,
    client: { id: IDS.client, fullName: 'Γιώργος Π.', phoneE164: '+306900000001' },
    services: [{ position: 0, serviceId: IDS.cut, durationMin: 30, priceCents: 1300 }],
    ...overrides,
  }
}
