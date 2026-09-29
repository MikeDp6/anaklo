import type { DayAppointment, StatusTarget } from '@/features/calendar/schema'

/**
 * What the appointment sheet offers. The server decides every change (AN020–AN023); these only
 * pick the buttons worth showing: «Ήρθε» / «Δεν ήρθε» once the appointment has started,
 * confirm before it, corrections between completed and no-show.
 */
export function statusTargets(appointment: DayAppointment, started: boolean): StatusTarget[] {
  switch (appointment.status) {
    case 'booked':
      return started ? ['completed', 'no_show'] : ['confirmed']
    case 'confirmed':
      return started ? ['completed', 'no_show'] : []
    case 'completed':
      return ['no_show']
    case 'no_show':
      return ['completed']
    case 'cancelled':
      return []
  }
}

/** Only booked/confirmed appointments move (move_core). */
export function canMove(appointment: DayAppointment): boolean {
  return appointment.status === 'booked' || appointment.status === 'confirmed'
}

export type D8Flag = 'outside_hours' | 'buffer_overlap'

/** The D8 flags of an attempt (part of its payload, so of its idempotency key). */
export interface D8Flags {
  readonly allowOutsideHours: boolean
  readonly allowBufferOverlap: boolean
}

/** Before any confirmation, and again after every change of time, staff member or service. */
export const NO_D8_FLAGS: D8Flags = { allowOutsideHours: false, allowBufferOverlap: false }

/** AN005 / AN006 → the flag a confirmed new attempt may set (SPEC §8.8, D8). */
export function d8FlagOf(code: string | null): D8Flag | null {
  if (code === 'AN005') return 'outside_hours'
  if (code === 'AN006') return 'buffer_overlap'
  return null
}

/** The flags of the next attempt after confirming `flag`. */
export function withD8Flag(flags: D8Flags, flag: D8Flag): D8Flags {
  return flag === 'outside_hours'
    ? { ...flags, allowOutsideHours: true }
    : { ...flags, allowBufferOverlap: true }
}
