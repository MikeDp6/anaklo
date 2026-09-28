import { useCallback, useEffect, useReducer, type Dispatch } from 'react'
import type { AppLocale } from '@/shared/lib/localDates'
import { useHardwareBack } from '../hooks/useHardwareBack'
import type { Catalogue } from '../schema'
import {
  bookingReducer,
  initialBookingState,
  type BookingEvent,
  type BookingState,
} from './bookingReducer'

/** Everything a step needs: the catalogue, the flow state and its dispatcher. */
export interface BookingFlow {
  catalogue: Catalogue
  state: BookingState
  dispatch: Dispatch<BookingEvent>
  /** The page language: the business's (the OTP SMS and a new client's language follow it). */
  locale: AppLocale
}

export function useBookingFlow(catalogue: Catalogue): BookingFlow {
  const [state, dispatch] = useReducer(bookingReducer, null, () => initialBookingState())
  const back = useCallback(() => dispatch({ type: 'back' }), [])

  useHardwareBack(state.step !== 'service', back)

  // A new step starts at the top (the cover and long lists would otherwise hide it).
  const { step, direction } = state
  useEffect(() => {
    if (direction !== 'none') window.scrollTo(0, 0)
  }, [step, direction])

  return { catalogue, state, dispatch, locale: catalogue.business.locale }
}
