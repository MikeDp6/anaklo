import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { BookClient } from '@fn-shared/booking-schemas.ts'
import { apiErrorCode } from '@/shared/lib/publicApi'
import { forgetSlots } from '../../api'
import { bookAppointment, forgetDevice, startVerification, verifyCode } from '../../bookingApi'
import {
  canResumeChallenge,
  type Attempt,
  type BookingState,
  type ClientPick,
  type Details,
  type Proof,
} from '../../flow/bookingReducer'
import type { BookingFlow } from '../../flow/useBookingFlow'

/** A v4 UUID for the idempotency key; `getRandomValues` also works where `randomUUID` does not. */
function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface BookInput {
  state: BookingState
  details: Details
  proof: Proof
  pick: ClientPick
}

/**
 * The server side of the later steps (contract 1.3 §4): `start`, `verify`, `book`, `forget`.
 * Nothing is shown as done before the server answers (rule 14). One request at a time per step:
 * a second tap while one runs is ignored, so `verify` is never sent twice at once.
 */
export function useBookingActions({ catalogue, state, dispatch, locale }: BookingFlow) {
  const businessId = catalogue.business.id
  const latest = useRef(state)
  const busy = useRef(false)
  // A layout effect, not a passive one: it runs in the same task as the commit, so no input can
  // arrive between the screen showing the new state (e.g. the code field emptied and editable
  // after a wrong code) and `once` seeing it. With useEffect, a code typed or autofilled in that
  // gap was silently dropped (`pending` still 'verify'): 6 digits in the field, no check.
  useLayoutEffect(() => {
    latest.current = state
  }, [state])

  const fail = useCallback(
    (error: unknown) => {
      const code = apiErrorCode(error)
      if (code === 'AN001') {
        forgetSlots()
        dispatch({ type: 'slotTaken' })
      } else if (code === 'AN014') {
        dispatch({ type: 'proofLost', code })
      } else {
        dispatch({ type: 'failed', code })
      }
    },
    [dispatch],
  )

  const book = useCallback(
    async ({ state: current, details, proof, pick }: BookInput) => {
      const { slot, serviceId, staffId } = current
      if (!slot || !serviceId) return
      const client: BookClient =
        pick.kind === 'existing'
          ? { kind: 'existing', client_id: pick.clientId }
          : { kind: 'new', full_name: details.fullName }
      const marketing_box = details.marketingRefused ? 'checked' : 'unchecked'
      const signature = JSON.stringify([
        slot.starts_at,
        serviceId,
        staffId,
        proof.phone,
        client,
        marketing_box,
      ])
      // A retry of the same request reuses its key (the server replays); anything else is new.
      const attempt: Attempt =
        current.attempt?.signature === signature
          ? current.attempt
          : { key: newKey(), signature, phone: proof.phone, pick }
      dispatch({ type: 'attempt', attempt })
      dispatch({ type: 'pending', pending: 'book' })
      try {
        const booking = await bookAppointment({
          business_id: businessId,
          idempotency_key: attempt.key,
          phone: proof.phone,
          locale,
          service_ids: [serviceId],
          staff_id: staffId,
          starts_at: slot.starts_at,
          grant: proof.via === 'otp' ? proof.grant : null,
          client,
          marketing_box,
        })
        forgetSlots()
        dispatch({ type: 'booked', booking })
      } catch (error) {
        fail(error)
      }
    },
    [businessId, dispatch, fail, locale],
  )

  /** After the proof: book at once when there is nobody to choose between. */
  const proven = useCallback(
    async (current: BookingState, details: Details, proof: Proof) => {
      dispatch({ type: 'proven', proof })
      if (proof.clients.length === 0)
        await book({ state: current, details, proof, pick: { kind: 'new' } })
    },
    [book, dispatch],
  )

  const start = useCallback(
    async (current: BookingState, details: Details) => {
      const { slot, serviceId, staffId } = current
      if (!slot || !serviceId) return
      dispatch({ type: 'pending', pending: 'start' })
      try {
        const answer = await startVerification({
          business_id: businessId,
          phone: details.phone,
          locale,
          service_ids: [serviceId],
          staff_id: staffId,
          starts_at: slot.starts_at,
        })
        if (answer.result === 'trusted') {
          const proof: Proof = {
            phone: details.phone,
            grant: null,
            via: 'trusted_device',
            clients: answer.clients,
          }
          await proven(current, details, proof)
        } else {
          const { challenge_id: id, expires_at: expiresAt, resend_at: resendAt } = answer
          dispatch({
            type: 'challenge',
            challenge: { id, phone: details.phone, expiresAt, resendAt },
          })
        }
      } catch (error) {
        fail(error)
      }
    },
    [businessId, dispatch, fail, locale, proven],
  )

  return useMemo(() => {
    const once = async (run: () => Promise<void>) => {
      if (busy.current || latest.current.pending !== null) return
      busy.current = true
      try {
        await run()
      } finally {
        busy.current = false
      }
    }
    return {
      submitDetails: (details: Details) =>
        once(async () => {
          const current = latest.current
          const proof = current.proof
          dispatch({ type: 'details', details })
          if (proof?.phone !== details.phone) {
            // The code already sent to this phone is still good: no new SMS.
            if (canResumeChallenge(current.challenge, details.phone, Date.now())) {
              dispatch({ type: 'resumeChallenge' })
              return
            }
            return start(current, details)
          }
          if (proof.clients.length === 0)
            return book({ state: current, details, proof, pick: { kind: 'new' } })
        }),
      resend: () =>
        once(async () => {
          const current = latest.current
          if (current.details) await start(current, current.details)
        }),
      verify: (code: string) =>
        once(async () => {
          const current = latest.current
          const { challenge, details } = current
          if (!challenge || !details) return
          dispatch({ type: 'pending', pending: 'verify' })
          try {
            const answer = await verifyCode({
              business_id: businessId,
              phone: challenge.phone,
              challenge_id: challenge.id,
              code,
            })
            const proof: Proof = {
              phone: challenge.phone,
              grant: answer.grant,
              via: 'otp',
              clients: answer.clients,
            }
            await proven(current, details, proof)
          } catch (error) {
            fail(error)
          }
        }),
      book: () =>
        once(async () => {
          const current = latest.current
          const { details, proof, pick } = current
          if (details && proof && pick) await book({ state: current, details, proof, pick })
        }),
      forget: () =>
        forgetDevice(businessId).then(
          () => true,
          () => false,
        ),
    }
  }, [book, businessId, dispatch, fail, proven, start])
}
