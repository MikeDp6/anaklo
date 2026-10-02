import type { DayAppointment, StatusTarget } from '@/features/calendar/schema'
import { canReceiveSms } from '@/shared/lib/phone'

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

/**
 * The note under a cancel or a move that asked for «Ενημέρωση με SMS» (contract 1.5 §4.5): the
 * server says whether an SMS to the client was queued (`sms_queued`); nothing when not asked.
 */
export function smsNoteKey(result: {
  readonly notify: boolean
  readonly smsQueued: boolean
}): 'notify.queued' | 'notify.notSent' | null {
  if (!result.notify) return null
  return result.smsQueued ? 'notify.queued' : 'notify.notSent'
}

/**
 * Whether cancel and move offer «Ενημέρωση με SMS»: a client whose phone can receive SMS (not a
 * Greek landline) and an appointment that has not started. A hint only: the server plans nothing
 * for a phone it cannot text and answers `sms_queued` (contract 1.5 §4.5).
 */
export function canNotifyClient(
  // Any appointment-like shape: the day sheet's appointment, or a conflict row of 1.6.
  appointment: {
    readonly startsAt: string
    readonly client: { readonly phoneE164: string | null } | null
  },
  now: Date,
): boolean {
  const phone = appointment.client?.phoneE164
  if (!phone) return false
  return canReceiveSms(phone) && Date.parse(appointment.startsAt) > now.getTime()
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
