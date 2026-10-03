import { describe, expect, it } from 'vitest'
import { DayAppointmentRows, toDayAppointment } from './schema'

// Test data only: one row of a staff member's day as PostgREST returns it.
function row(client: unknown) {
  return DayAppointmentRows.parse([
    {
      id: '00000000-0000-4000-8000-00000000d001',
      staff_id: '00000000-0000-4000-8000-000000000101',
      client_id: '00000000-0000-4000-8000-00000000c001',
      starts_at: '2026-09-29T07:00:00+00:00',
      ends_at: '2026-09-29T07:30:00+00:00',
      buffer_after_min: 5,
      status: 'completed',
      source: 'phone',
      total_cents: 1300,
      cancel_reason: null,
      client,
      services: [
        {
          position: 1,
          service_id: '00000000-0000-4000-8000-000000000303',
          duration_min: 15,
          price_cents: 700,
        },
        {
          position: 0,
          service_id: '00000000-0000-4000-8000-000000000301',
          duration_min: 30,
          price_cents: 1300,
        },
      ],
    },
  ])[0]
}

describe('toDayAppointment (contract 1.8 §4.10)', () => {
  it('maps a live client and orders the service lines by position', () => {
    const parsed = row({
      id: '00000000-0000-4000-8000-00000000c001',
      full_name: 'Γιώργος Π.',
      phone_e164: '+306900000001',
      erased_at: null,
    })
    if (!parsed) throw new Error('no row')
    const appointment = toDayAppointment(parsed)
    expect(appointment.client).toEqual({
      id: '00000000-0000-4000-8000-00000000c001',
      fullName: 'Γιώργος Π.',
      phoneE164: '+306900000001',
    })
    expect(appointment.services.map((line) => line.position)).toEqual([0, 1])
  })

  it('an erased client is no client: the day says «Walk-in χωρίς όνομα», never an empty name', () => {
    const parsed = row({
      id: '00000000-0000-4000-8000-00000000c001',
      full_name: '',
      phone_e164: null,
      erased_at: '2026-10-03T09:00:00+00:00',
    })
    if (!parsed) throw new Error('no row')
    const appointment = toDayAppointment(parsed)
    expect(appointment.client).toBeNull()
    // The appointment itself stays (statistics), linked to the anonymous row.
    expect(appointment.clientId).toBe('00000000-0000-4000-8000-00000000c001')
    expect(appointment.status).toBe('completed')
  })

  it('a walk-in without a client stays without one', () => {
    const parsed = row(null)
    if (!parsed) throw new Error('no row')
    expect(toDayAppointment(parsed).client).toBeNull()
  })
})
