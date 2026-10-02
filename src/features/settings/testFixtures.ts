import type { SettingsFrame } from './hooks/useSettingsFrame'
import type { ScheduleConflict } from './schema'

/** Synthetic test data of the settings Vitest files (the demo shop of the seed). Never bundled. */
export const SETTINGS_IDS = {
  business: '00000000-0000-4000-8000-000000000001',
  nikos: '00000000-0000-4000-8000-000000000101',
  alex: '00000000-0000-4000-8000-000000000102',
  maria: '00000000-0000-4000-8000-000000000103',
  cut: '00000000-0000-4000-8000-000000000301',
  client: '00000000-0000-4000-8000-00000000c001',
  first: '00000000-0000-4000-8000-00000000d001',
  second: '00000000-0000-4000-8000-00000000d002',
} as const

const STAFF = [
  { id: SETTINGS_IDS.nikos, displayName: 'Νίκος', color: '#C8A15A', sort: 0, active: true },
  { id: SETTINGS_IDS.alex, displayName: 'Άλεξ', color: '#4F7CAC', sort: 1, active: true },
  { id: SETTINGS_IDS.maria, displayName: 'Μαρία', color: null, sort: 2, active: true },
]

export function testFrame(): SettingsFrame {
  return {
    businessId: SETTINGS_IDS.business,
    business: {
      id: SETTINGS_IDS.business,
      name: 'Demo Barber',
      timeZone: 'Europe/Athens',
      currency: 'EUR',
      locale: 'el',
      slotStepMin: 15,
      correctionWindowDays: 3,
    },
    staff: STAFF,
    activeStaff: STAFF,
    staffNames: new Map(STAFF.map((member) => [member.id, member.displayName])),
  }
}

export const SERVICE_NAMES: ReadonlyMap<string, string> = new Map([[SETTINGS_IDS.cut, 'Κούρεμα']])

/** Νίκος's appointment at 10:00–10:30 Athens on 2026-10-02, a client with a mobile number. */
export function testConflict(partial: Partial<ScheduleConflict> = {}): ScheduleConflict {
  return {
    appointmentId: SETTINGS_IDS.first,
    staffId: SETTINGS_IDS.nikos,
    startsAt: '2026-10-02T07:00:00+00:00',
    endsAt: '2026-10-02T07:30:00+00:00',
    status: 'booked',
    source: 'phone',
    clientId: SETTINGS_IDS.client,
    clientName: 'Κώστας Μ.',
    clientPhoneE164: '+306912345678',
    serviceIds: [SETTINGS_IDS.cut],
    reasons: ['time_off'],
    ...partial,
  }
}
