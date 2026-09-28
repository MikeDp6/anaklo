import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { bookingCatalogues } from '@/shared/i18n/booking'
import type { Challenge } from '../../flow/bookingReducer'
import type { Slot } from '../../schema'
import { CUT, TEST_SLOT, testCatalogue, testFlow } from '../../testFixtures'
import { OtpStep } from './OtpStep'

const api = vi.hoisted(() => ({ fetchSlots: vi.fn(), forgetSlots: vi.fn() }))
vi.mock('../../api', () => api)

const T0 = Date.parse('2026-10-01T05:00:00Z')

function challenge(id: string, sentAt: number): Challenge {
  return {
    id,
    phone: '+306900000001',
    expiresAt: new Date(sentAt + 300_000).toISOString(),
    resendAt: new Date(sentAt + 60_000).toISOString(),
  }
}

beforeAll(async () => {
  await initI18n(bookingCatalogues)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('OtpStep', () => {
  it('a resend minutes after the last countdown counts from now, not from a stale clock', () => {
    vi.useFakeTimers({ now: T0 })
    const flow = testFlow(testCatalogue(), { step: 'otp', challenge: challenge('c1', T0) })
    const { rerender } = render(<OtpStep flow={flow} />)
    expect(screen.getByRole('button', { name: 'Νέος κωδικός σε 60″' })).toBeDisabled()
    act(() => {
      vi.advanceTimersByTime(61_000)
    })
    expect(screen.getByRole('button', { name: 'Στείλε νέο κωδικό' })).toBeEnabled()

    // Three minutes later (no tick meanwhile: the countdown had ended) a new code is sent.
    vi.setSystemTime(T0 + 180_000)
    rerender(
      <OtpStep
        flow={{ ...flow, state: { ...flow.state, challenge: challenge('c2', T0 + 180_000) } }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Νέος κωδικός σε 60″' })).toBeDisabled()
  })

  it('AN001 on a resend offers nearby free times on the code step itself', async () => {
    const nearby: Slot = {
      ...TEST_SLOT,
      starts_at: '2026-10-01T06:15:00+00:00',
      local_time: '09:15:00',
    }
    api.fetchSlots.mockResolvedValue([TEST_SLOT, nearby])
    const flow = testFlow(testCatalogue(), {
      step: 'otp',
      serviceId: CUT,
      slot: TEST_SLOT,
      takenSlot: TEST_SLOT,
      error: 'AN001',
      challenge: challenge('c1', Date.now()),
    })
    render(<OtpStep flow={flow} />)

    expect(screen.getByText('Η ώρα 09:00 μόλις κλείστηκε')).toBeInTheDocument()
    const alternative = await screen.findByRole('button', { name: '09:15' })
    // One alert (the panel), not a second «pick another time» without any time to pick.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    alternative.click()
    expect(flow.dispatch).toHaveBeenCalledWith({ type: 'alternative', slot: nearby })
  })
})
