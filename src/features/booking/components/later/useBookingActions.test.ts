import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
