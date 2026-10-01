import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PENDING_EMAIL_TTL_MS,
  readPendingEmail,
  readPendingSignIn,
  savePendingEmail,
} from './pendingEmail'
import { readLastActivity, writeLastActivity } from './sessionPolicy'
import {
  cleanUpDevice,
  confirmLoginCode,
  currentActiveUser,
  requestLoginCode,
  signOut,
} from './session'

// The real wiring of session.ts, with Supabase and OneSignal replaced.
const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  sendEmailCode: vi.fn(),
  verifyEmailCode: vi.fn(),
  signOutOfSupabase: vi.fn(),
  optOutPush: vi.fn(),
  retryPendingOptOut: vi.fn(),
  unregisterPushSubscription: vi.fn(),
}))

vi.mock('./api', () => ({
  getSessionUser: mocks.getSessionUser,
  sendEmailCode: mocks.sendEmailCode,
  verifyEmailCode: mocks.verifyEmailCode,
  signOutOfSupabase: mocks.signOutOfSupabase,
}))
vi.mock('@/features/push/oneSignal', () => ({
  optOutPush: mocks.optOutPush,
  retryPendingOptOut: mocks.retryPendingOptOut,
}))
vi.mock('@/features/push/api', () => ({
  unregisterPushSubscription: mocks.unregisterPushSubscription,
}))

const DAY = 24 * 60 * 60 * 1000
const USER = { userId: '00000000-0000-4000-8000-00000000a001', email: 'owner@demo-barber.test' }

beforeEach(() => {
  window.localStorage.clear()
  mocks.optOutPush.mockResolvedValue(undefined)
  mocks.retryPendingOptOut.mockReset()
  mocks.retryPendingOptOut.mockResolvedValue(undefined)
  mocks.signOutOfSupabase.mockResolvedValue({ ok: true })
})

describe('signOut', () => {
  it('defaults to this device only (scope local) and opts push out', async () => {
    await signOut()
    expect(mocks.signOutOfSupabase).toHaveBeenCalledWith('local')
    expect(mocks.optOutPush).toHaveBeenCalledOnce()
  })

  it('opts out AND unregisters this device before Auth forgets the session (ADR-0010 §7)', async () => {
    const order: string[] = []
    mocks.unregisterPushSubscription.mockImplementation((id: string) => {
      order.push(`unregister:${id}`)
      return Promise.resolve(1)
    })
    mocks.optOutPush.mockImplementation(
      async (options?: { unregister?: (id: string) => Promise<unknown> }) => {
        order.push('optOut')
        await options?.unregister?.('8b1f6a52-3c1e-4c0d-9a4e-2f7d1c9b0e11')
      },
    )
    mocks.signOutOfSupabase.mockImplementation((scope: string) => {
      order.push(`signOut:${scope}`)
      return Promise.resolve({ ok: true })
    })
    await signOut()
    expect(order).toEqual([
      'optOut',
      'unregister:8b1f6a52-3c1e-4c0d-9a4e-2f7d1c9b0e11',
      'signOut:local',
    ])
  })

  it('forgets the activity timestamp and a pending sign-in', async () => {
    writeLastActivity(window.localStorage, new Date())
    savePendingEmail(window.localStorage, 'owner@demo-barber.test', new Date())
    await signOut({ scope: 'global' })
    expect(mocks.signOutOfSupabase).toHaveBeenCalledWith('global')
    expect(readLastActivity(window.localStorage)).toBeNull()
    expect(readPendingEmail(window.localStorage, new Date())).toBeNull()
  })
})

describe('currentActiveUser (30-day guard)', () => {
  const now = new Date('2026-10-15T09:00:00Z')

  it('an active session gets a new timestamp', async () => {
    mocks.getSessionUser.mockResolvedValue(USER)
    writeLastActivity(window.localStorage, new Date(now.getTime() - 29 * DAY))
    await expect(currentActiveUser(now)).resolves.toEqual(USER)
    expect(readLastActivity(window.localStorage)).toEqual(now)
    expect(mocks.signOutOfSupabase).not.toHaveBeenCalled()
  })

  it('an active session retries an opt-out the previous user left pending (ADR-0010 §2)', async () => {
    // Every guard run: a sign-in on the same page, a navigation, a return to the app. Not only
    // the Notifications screen, so a shared phone stops getting the previous user's pushes.
    mocks.getSessionUser.mockResolvedValue(USER)
    await expect(currentActiveUser(now)).resolves.toEqual(USER)
    expect(mocks.retryPendingOptOut).toHaveBeenCalledOnce()
  })

  it('the guard never waits for that retry (offline, slow CDN)', async () => {
    mocks.getSessionUser.mockResolvedValue(USER)
    mocks.retryPendingOptOut.mockReturnValue(new Promise<void>(() => undefined))
    await expect(currentActiveUser(now)).resolves.toEqual(USER)
  })

  it('after 31 idle days the same sign-out runs (local + push) and there is no user', async () => {
    mocks.getSessionUser.mockResolvedValue(USER)
    writeLastActivity(window.localStorage, new Date(now.getTime() - 31 * DAY))
    await expect(currentActiveUser(now)).resolves.toBeNull()
    expect(mocks.signOutOfSupabase).toHaveBeenCalledWith('local')
    expect(mocks.optOutPush).toHaveBeenCalled()
    expect(mocks.retryPendingOptOut).not.toHaveBeenCalled()
  })

  it('without a session the device is cleaned up and no timestamp is written', async () => {
    mocks.getSessionUser.mockResolvedValue(null)
    writeLastActivity(window.localStorage, new Date(now.getTime() - DAY))
    await expect(currentActiveUser(now)).resolves.toBeNull()
    expect(mocks.optOutPush).toHaveBeenCalled()
    expect(readLastActivity(window.localStorage)).toBeNull()
  })

  it('the cleanup without a session opts out only: nothing to unregister with', async () => {
    mocks.getSessionUser.mockResolvedValue(null)
    mocks.optOutPush.mockClear()
    mocks.unregisterPushSubscription.mockClear()
    await cleanUpDevice()
    await currentActiveUser(now)
    for (const call of mocks.optOutPush.mock.calls) expect(call).toEqual([])
    expect(mocks.unregisterPushSubscription).not.toHaveBeenCalled()
  })

  it('without a session a pending sign-in survives (iOS reopened the app on /app)', async () => {
    mocks.getSessionUser.mockResolvedValue(null)
    savePendingEmail(window.localStorage, 'owner@demo-barber.test', new Date())
    await expect(currentActiveUser(new Date())).resolves.toBeNull()
    expect(readPendingEmail(window.localStorage, new Date())).toBe('owner@demo-barber.test')
  })
})

describe('requestLoginCode / confirmLoginCode', () => {
  const email = 'owner@demo-barber.test'

  it('saves the pending email before the code is requested', async () => {
    mocks.sendEmailCode.mockImplementation(() => {
      expect(readPendingEmail(window.localStorage, new Date())).toBe(email)
      return Promise.resolve(null)
    })
    await expect(requestLoginCode(email)).resolves.toMatchObject({ codeStep: true })
  })

  it('an unknown email keeps the pending email, like a known one', async () => {
    mocks.sendEmailCode.mockResolvedValue(new AuthApiError('no', 422, 'otp_disabled'))
    await expect(requestLoginCode(email)).resolves.toMatchObject({ codeStep: true })
    expect(readPendingEmail(window.localStorage, new Date())).toBe(email)
  })

  it('a network failure on the first request forgets the pending email', async () => {
    mocks.sendEmailCode.mockResolvedValue(new AuthRetryableFetchError('Failed to fetch', 0))
    await expect(requestLoginCode(email)).resolves.toMatchObject({ codeStep: false })
    expect(readPendingEmail(window.localStorage, new Date())).toBeNull()
  })

  it.each([
    ['a network failure', new AuthRetryableFetchError('Failed to fetch', 0)],
    ['the per-IP limit', new AuthApiError('slow down', 429, 'over_request_rate_limit')],
  ])(
    'a resend that fails with %s keeps the earlier pending sign-in as it was',
    async (_, error) => {
      // The first code was sent a minute ago and is still valid; the screen stays on the code step.
      const sentAt = new Date(Date.now() - 60_000)
      savePendingEmail(window.localStorage, email, sentAt)
      const before = readPendingSignIn(window.localStorage, new Date())
      mocks.sendEmailCode.mockResolvedValue(error)

      await expect(requestLoginCode(email)).resolves.toMatchObject({ codeStep: false })
      expect(readPendingSignIn(window.localStorage, new Date())).toEqual(before)
      expect(before?.expiresAt).toBe(sentAt.getTime() + PENDING_EMAIL_TTL_MS)
    },
  )

  it('a resend that sends a new code extends the pending sign-in', async () => {
    const sentAt = new Date(Date.now() - 5 * 60_000)
    savePendingEmail(window.localStorage, email, sentAt)
    mocks.sendEmailCode.mockResolvedValue(null)
    await expect(requestLoginCode(email)).resolves.toMatchObject({ codeStep: true })
    const pending = readPendingSignIn(window.localStorage, new Date())
    expect(pending?.email).toBe(email)
    expect(pending?.expiresAt).toBeGreaterThan(sentAt.getTime() + PENDING_EMAIL_TTL_MS)
  })

  it('a failed request for another email does not bring back the earlier one', async () => {
    savePendingEmail(window.localStorage, 'manager@demo-barber.test', new Date())
    mocks.sendEmailCode.mockResolvedValue(new AuthRetryableFetchError('Failed to fetch', 0))
    await expect(requestLoginCode(email)).resolves.toMatchObject({ codeStep: false })
    expect(readPendingEmail(window.localStorage, new Date())).toBeNull()
  })

  it('a correct code clears the pending email and starts a new activity period', async () => {
    savePendingEmail(window.localStorage, email, new Date())
    writeLastActivity(window.localStorage, new Date(Date.now() - 40 * DAY))
    mocks.verifyEmailCode.mockResolvedValue(null)
    await expect(confirmLoginCode(email, '123456')).resolves.toEqual({
      signedIn: true,
      messageKey: null,
    })
    expect(mocks.verifyEmailCode).toHaveBeenCalledWith(email, '123456')
    expect(readPendingEmail(window.localStorage, new Date())).toBeNull()
    const lastActivity = readLastActivity(window.localStorage)
    expect(Date.now() - (lastActivity?.getTime() ?? 0)).toBeLessThan(DAY)
  })

  it('a wrong code keeps the pending email', async () => {
    savePendingEmail(window.localStorage, email, new Date())
    mocks.verifyEmailCode.mockResolvedValue(new AuthApiError('bad', 403, 'otp_expired'))
    await expect(confirmLoginCode(email, '000000')).resolves.toMatchObject({ signedIn: false })
    expect(readPendingEmail(window.localStorage, new Date())).toBe(email)
  })
})
