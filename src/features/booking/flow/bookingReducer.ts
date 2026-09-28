import type {
  BookResponse,
  ClientChoice,
  VerifiedVia,
} from '../../../../supabase/functions/_shared/booking-schemas.ts'
import type { Slot } from '../schema'

/**
 * The booking flow as a pure reducer (phase 1 §1.3): service → staff (only with ≥ 2 staff for
 * the service) → slot → details → OTP (only on a new device) → client choice → done.
 * The grant lives here, in memory only; one service per booking (D9).
 */
export type Step = 'service' | 'staff' | 'slot' | 'details' | 'otp' | 'client' | 'done'
export type Direction = 'none' | 'forward' | 'back'
export type Pending = 'start' | 'verify' | 'book'

export interface Details {
  fullName: string
  /** E.164 (phone.ts). */
  phone: string
  /** The refusal box: true = the client does NOT want marketing SMS. */
  marketingRefused: boolean
}

export interface Challenge {
  id: string
  phone: string
  expiresAt: string
  resendAt: string
  /** The server answered AN011/AN012 for it: only a new code helps. */
  spent?: true
}

/** Time left to type the code when a visitor returns to it (a resend would cost a new SMS). */
const RESUME_MARGIN_MS = 30_000

/**
 * Back on the details with the same phone (a typo in the name, say): the code already sent is
 * still good, so the OTP step comes back instead of a new `start` (no AN019 wait, no second SMS
 * counted against the per-phone limit).
 */
export function canResumeChallenge(
  challenge: Challenge | null,
  phone: string,
  now: number,
): challenge is Challenge {
  return (
    challenge !== null &&
    challenge.spent !== true &&
    challenge.phone === phone &&
    Date.parse(challenge.expiresAt) - now > RESUME_MARGIN_MS
  )
}

/** What proves the phone for this business: a live grant (OTP) or the trusted device. */
export interface Proof {
  phone: string
  grant: string | null
  via: VerifiedVia
  clients: ClientChoice[]
}

export type ClientPick = { kind: 'existing'; clientId: string } | { kind: 'new' }

/** One booking attempt: its idempotency key is reused only for the identical request body. */
export interface Attempt {
  key: string
  signature: string
  /** The phone and the client choice it was sent with (kept across a lost proof). */
  phone: string
  pick: ClientPick
}

function offered(pick: ClientPick, clients: readonly ClientChoice[]): boolean {
  return pick.kind === 'new' || clients.some((client) => client.id === pick.clientId)
}

export interface BookingState {
  step: Step
  direction: Direction
  staffStep: boolean
  serviceId: string | null
  /** null = any staff member (or not chosen yet). */
  staffId: string | null
  /** Which 14-day window of dates the slot step shows (0 = from today). */
  window: number
  date: string | null
  slot: Slot | null
  /** The slot the server just refused (AN001): the page offers nearby alternatives. */
  takenSlot: Slot | null
  details: Details | null
  challenge: Challenge | null
  proof: Proof | null
  pick: ClientPick | null
  attempt: Attempt | null
  pending: Pending | null
  /** An error code (`AN0xx`, `network`, …) for the current step, mapped through i18n. */
  error: string | null
  booking: BookResponse | null
}

export type BookingEvent =
  | { type: 'service'; serviceId: string; staffStep: boolean; staffId: string | null }
  | { type: 'staff'; staffId: string | null }
  | { type: 'window'; window: number }
  | { type: 'date'; date: string }
  | { type: 'slot'; slot: Slot }
  | { type: 'alternative'; slot: Slot }
  | { type: 'details'; details: Details }
  | { type: 'pending'; pending: Pending }
  | { type: 'failed'; code: string }
  | { type: 'challenge'; challenge: Challenge }
  /** Back to the code already sent (see canResumeChallenge). */
  | { type: 'resumeChallenge' }
  | { type: 'proven'; proof: Proof }
  | { type: 'pick'; pick: ClientPick }
  | { type: 'attempt'; attempt: Attempt }
  | { type: 'booked'; booking: BookResponse }
  | { type: 'slotTaken' }
  | { type: 'proofLost'; code: string }
  /** Back to the full list of times (from the AN001 alternatives). */
  | { type: 'slots' }
  | { type: 'back' }
  | { type: 'restart' }

export function initialBookingState(details: Details | null = null): BookingState {
  return {
    step: 'service',
    direction: 'none',
    staffStep: false,
    serviceId: null,
    staffId: null,
    window: 0,
    date: null,
    slot: null,
    takenSlot: null,
    details,
    challenge: null,
    proof: null,
    pick: null,
    attempt: null,
    pending: null,
    error: null,
    booking: null,
  }
}

/** Lower case, no accents: «Γιώργος» and «γιωργος» are the same first name. */
export function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('el').trim()
}

/** The client whose first name is the typed one; otherwise a new client (never by phone alone). */
export function defaultPick(clients: readonly ClientChoice[], fullName: string): ClientPick {
  const typed = normalizeName(fullName.trim().split(/\s+/)[0] ?? '')
  const match = clients.find((client) => normalizeName(client.first_name) === typed)
  return match ? { kind: 'existing', clientId: match.id } : { kind: 'new' }
}

function previousStep(state: BookingState): Step {
  switch (state.step) {
    case 'staff':
      return 'service'
    case 'slot':
      return state.staffStep ? 'staff' : 'service'
    case 'details':
      return 'slot'
    case 'otp':
    case 'client':
      return 'details'
    default:
      return state.step
  }
}

const cleanRequest = { pending: null, error: null } as const

export function bookingReducer(state: BookingState, event: BookingEvent): BookingState {
  switch (event.type) {
    case 'service':
      return {
        ...initialBookingState(state.details),
        proof: state.proof,
        serviceId: event.serviceId,
        staffStep: event.staffStep,
        staffId: event.staffId,
        step: event.staffStep ? 'staff' : 'slot',
        direction: 'forward',
      }
    case 'staff':
      return {
        ...state,
        ...cleanRequest,
        staffId: event.staffId,
        window: 0,
        date: null,
        slot: null,
        takenSlot: null,
        attempt: null,
        step: 'slot',
        direction: 'forward',
      }
    case 'window':
      return { ...state, window: Math.max(0, event.window), date: null }
    case 'date':
      return { ...state, date: event.date }
    case 'slot':
      return {
        ...state,
        ...cleanRequest,
        slot: event.slot,
        date: event.slot.local_date,
        takenSlot: null,
        attempt: null,
        step: 'details',
        direction: 'forward',
      }
    case 'alternative':
      return {
        ...state,
        ...cleanRequest,
        slot: event.slot,
        date: event.slot.local_date,
        takenSlot: null,
        attempt: null,
        direction: 'none',
      }
    case 'details': {
      const samePhone = state.proof?.phone === event.details.phone
      if (!samePhone) {
        return { ...state, ...cleanRequest, details: event.details, proof: null, pick: null }
      }
      return {
        ...state,
        ...cleanRequest,
        details: event.details,
        pick: defaultPick(state.proof?.clients ?? [], event.details.fullName),
        step: 'client',
        direction: 'forward',
      }
    }
    case 'pending':
      return { ...state, pending: event.pending, error: null }
    case 'failed':
      return {
        ...state,
        pending: null,
        error: event.code,
        challenge:
          state.challenge && (event.code === 'AN011' || event.code === 'AN012')
            ? { ...state.challenge, spent: true }
            : state.challenge,
      }
    case 'challenge':
      return {
        ...state,
        ...cleanRequest,
        challenge: event.challenge,
        step: 'otp',
        direction: state.step === 'otp' ? 'none' : 'forward',
      }
    case 'resumeChallenge':
      if (!state.challenge) return state
      return { ...state, ...cleanRequest, step: 'otp', direction: 'forward' }
    case 'proven': {
      // After a lost proof the pending attempt's own choice comes back (a client it created
      // meanwhile is now listed, and picking them would change the request and its key).
      const kept = state.attempt
      const pick =
        kept && kept.phone === event.proof.phone && offered(kept.pick, event.proof.clients)
          ? kept.pick
          : defaultPick(event.proof.clients, state.details?.fullName ?? '')
      return {
        ...state,
        ...cleanRequest,
        proof: event.proof,
        challenge: null,
        pick,
        step: 'client',
        direction: 'forward',
      }
    }
    case 'pick':
      return { ...state, pick: event.pick, error: null }
    case 'attempt':
      return { ...state, attempt: event.attempt }
    case 'booked':
      return {
        ...state,
        ...cleanRequest,
        booking: event.booking,
        // The grant is consumed: a new booking proves the phone again (or the trusted device).
        proof: state.proof ? { ...state.proof, grant: null } : null,
        step: 'done',
        direction: 'forward',
      }
    case 'slotTaken':
      return { ...state, pending: null, error: 'AN001', takenSlot: state.slot, attempt: null }
    case 'proofLost':
      // The attempt (its idempotency key) stays: if the lost proof hid a booking that did commit
      // (its answer never arrived), the same request after a new proof replays that booking
      // instead of booking again. The signature leaves the grant out on purpose.
      return {
        ...state,
        pending: null,
        error: event.code,
        proof: null,
        challenge: null,
        pick: null,
        step: 'details',
        direction: 'back',
      }
    case 'slots':
      if (state.pending !== null) return state
      return { ...state, ...cleanRequest, takenSlot: null, step: 'slot', direction: 'back' }
    case 'back':
      if (state.pending !== null) return state
      if (state.step === 'done') return bookingReducer(state, { type: 'restart' })
      return {
        ...state,
        ...cleanRequest,
        takenSlot: null,
        step: previousStep(state),
        direction: 'back',
      }
    case 'restart':
      return { ...initialBookingState(state.details), direction: 'back' }
  }
}

export function canGoBack(state: BookingState): boolean {
  return state.pending === null && state.step !== 'service' && state.step !== 'done'
}

/** E19: phases service, (staff), slot, details (+ OTP and client choice); done = full. */
export function progressOf(state: BookingState): { value: number; max: number } {
  const phases: Step[] = ['service', ...(state.staffStep ? (['staff'] as const) : []), 'slot']
  phases.push('details')
  const max = phases.length
  if (state.step === 'done') return { value: max, max }
  const step = state.step === 'otp' || state.step === 'client' ? 'details' : state.step
  return { value: Math.max(0, phases.indexOf(step)), max }
}
