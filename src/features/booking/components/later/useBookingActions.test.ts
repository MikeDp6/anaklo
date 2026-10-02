import { useLayoutEffect } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BookingFlow } from '../../flow/useBookingFlow'
import type { Challenge, Details } from '../../flow/bookingReducer'
import { CUT, TEST_SLOT, testCatalogue, testFlow } from '../../testFixtures'
import { useBookingActions } from './useBookingActions'

const api = vi.hoisted(() => ({
  startVerification: vi.fn(),
  verifyCode: vi.fn(),
  bookAppointment: vi.fn(),
  forgetDevice: vi.fn(),
}))
vi.mock('../../bookingApi', () => api)

const DETAILS: Details = {
  fullName: 'Γιώργος Παππάς',
  phone: '+306900000001',
  marketingRefused: false,
}

function sentSecondsAgo(seconds: number): Challenge {
  const sent = Date.now() - seconds * 1000
  return {
    id: 'c1',
    phone: DETAILS.phone,
    expiresAt: new Date(sent + 300_000).toISOString(),
    resendAt: new Date(sent + 60_000).toISOString(),
  }
}

function detailsFlow(challenge: Challenge) {
  return testFlow(testCatalogue(), {
    step: 'details',
    serviceId: CUT,
    slot: TEST_SLOT,
    details: { ...DETAILS, fullName: 'Γιώργος Παπάς' },
    challenge,
  })
}

describe('useBookingActions: back from the code to the details', () => {
  it('the same phone goes back to the code already sent: no new start, no second SMS', async () => {
    const flow = detailsFlow(sentSecondsAgo(20))
    const { result } = renderHook(() => useBookingActions(flow))
    await result.current.submitDetails(DETAILS)
    expect(api.startVerification).not.toHaveBeenCalled()
    expect(flow.dispatch).toHaveBeenCalledWith({ type: 'details', details: DETAILS })
    expect(flow.dispatch).toHaveBeenLastCalledWith({ type: 'resumeChallenge' })
  })

  it('a code about to expire (or another phone) asks for a new one', async () => {
    api.startVerification.mockResolvedValue({
      result: 'otp_sent',
      challenge_id: '00000000-0000-4000-8000-0000000000c2',
      expires_at: '2026-10-01T06:05:00Z',
      resend_at: '2026-10-01T06:01:00Z',
    })
    const flow = detailsFlow(sentSecondsAgo(290))
    const { result } = renderHook(() => useBookingActions(flow))
    await result.current.submitDetails(DETAILS)
    expect(api.startVerification).toHaveBeenCalledTimes(1)
    expect(flow.dispatch).not.toHaveBeenCalledWith({ type: 'resumeChallenge' })
  })
})

describe('useBookingActions: a code right after a wrong one', () => {
  it('is checked even when it comes in the same task as the screen that allows it', async () => {
    api.verifyCode.mockRejectedValue(new Error('wrong code'))
    const verifying = testFlow(testCatalogue(), {
      step: 'otp',
      serviceId: CUT,
      slot: TEST_SLOT,
      details: DETAILS,
      challenge: sentSecondsAgo(20),
      pending: 'verify',
    })
    const idle: BookingFlow = { ...verifying, state: { ...verifying.state, pending: null } }
    // The earliest moment a visitor (or the phone's code autofill) can act: the commit that
    // emptied the field and made it editable again, before any passive effect has run.
    const { rerender } = renderHook(
      ({ flow }: { flow: BookingFlow }) => {
        const actions = useBookingActions(flow)
        useLayoutEffect(() => {
          if (flow.state.pending === null) void actions.verify('123456')
        }, [actions, flow.state.pending])
      },
      { initialProps: { flow: verifying } },
    )
    expect(api.verifyCode).not.toHaveBeenCalled()
    rerender({ flow: idle })
    await waitFor(() => expect(api.verifyCode).toHaveBeenCalledTimes(1))
  })
})
