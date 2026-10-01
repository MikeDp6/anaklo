import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { OneSignalApi, PushSubscriptionChange } from '../oneSignal'
import type * as OneSignalModule from '../oneSignal'
import { NotificationsPage } from './NotificationsPage'

// The screen with its real hooks and the real enable logic; replaced: the member (route loader),
// the RPCs, the app id, and the SDK start (the CDN). The SDK itself is a fake.
const mocks = vi.hoisted(() => ({
  appId: vi.fn<() => string | null>(),
  startPush: vi.fn<(appId: string) => Promise<OneSignalApi>>(),
  registerPushSubscription: vi.fn(),
  unregisterPushSubscription: vi.fn(),
  fetchMyPushSubscriptions: vi.fn(),
  requestTestPush: vi.fn(),
}))
vi.mock('../env', () => ({ readOneSignalAppId: mocks.appId }))
vi.mock('../api', () => ({
  registerPushSubscription: mocks.registerPushSubscription,
  unregisterPushSubscription: mocks.unregisterPushSubscription,
  fetchMyPushSubscriptions: mocks.fetchMyPushSubscriptions,
  requestTestPush: mocks.requestTestPush,
}))
vi.mock('../oneSignal', async (importOriginal) => ({
  ...(await importOriginal<typeof OneSignalModule>()),
  startPush: mocks.startPush,
}))
vi.mock('@/features/auth/hooks/useMember', () => ({
  useMember: () => ({
    user: { userId: USER_ID, email: 'owner@demo-barber.test' },
    membership: { businessId: BUSINESS_ID, role: 'staff', staffId: null },
    memberships: [],
  }),
}))

const USER_ID = '00000000-0000-4000-8000-00000000a003'
const BUSINESS_ID = '00000000-0000-4000-8000-000000000b01'
const APP_ID = '5f0e0d0c-0000-4000-8000-0000000000aa'
const DEVICE = '8b1f6a52-3c1e-4c0d-9a4e-2f7d1c9b0e11'

const TEXT = {
  unavailable: 'Οι ειδοποιήσεις δεν είναι διαθέσιμες ακόμη.',
  needsInstall: 'Πρόσθεσε πρώτα την εφαρμογή στην αρχική οθόνη.',
  off: 'Οι ειδοποιήσεις δεν είναι ενεργές σε αυτή τη συσκευή.',
  on: 'Οι ειδοποιήσεις είναι ενεργές σε αυτή τη συσκευή.',
  registerFailed: 'Οι ειδοποιήσεις δεν ενεργοποιήθηκαν. Δοκίμασε ξανά.',
  enable: 'Ενεργοποίηση ειδοποιήσεων',
  test: 'Δοκιμαστική ειδοποίηση',
  testSent: 'Στάλθηκε. Θα φτάσει σε λίγα δευτερόλεπτα σε κάθε συσκευή σου με ενεργές ειδοποιήσεις.',
  testNotRegistered: 'Ενεργοποίησε πρώτα τις ειδοποιήσεις σε αυτή τη συσκευή.',
} as const

/** A OneSignal page SDK that already knows this device's id (a shared phone used before). */
function fakeSdk(options: { id: string | null; optedIn: boolean }) {
  const notification = { permission: 'default' as NotificationPermission }
  vi.stubGlobal('Notification', notification)
  const listeners = new Set<(change: PushSubscriptionChange) => void>()
  const report = () => {
    for (const listener of [...listeners]) {
      listener({ current: { id: subscription.id, optedIn: subscription.optedIn } })
    }
  }
  const subscription = {
    id: options.id,
    optedIn: options.optedIn,
    optIn: vi.fn(() => {
      subscription.optedIn = true
      report()
      return Promise.resolve()
    }),
    optOut: vi.fn(() => {
      subscription.optedIn = false
      report()
      return Promise.resolve()
    }),
    addEventListener: (_: 'change', listener: (change: PushSubscriptionChange) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_: 'change', listener: (change: PushSubscriptionChange) => void) => {
      listeners.delete(listener)
    },
  }
  const requestPermission = vi.fn(() => {
    notification.permission = 'granted'
    return Promise.resolve()
  })
  const login = vi.fn()
  const api: OneSignalApi = Object.assign(
    {
      init: vi.fn(() => Promise.resolve()),
      Notifications: { isPushSupported: () => true, requestPermission },
      User: { PushSubscription: subscription },
    },
    { login },
  )
  return { api, subscription, requestPermission, login }
}

function row(subscriptionId: string) {
  return {
    id: '00000000-0000-4000-8000-0000000f0aaa',
    provider: 'onesignal',
    subscriptionId,
    createdAt: '2026-09-29T08:00:00Z',
    updatedAt: '2026-09-29T08:00:00Z',
  }
}

function stubDevice({ iPhone, standalone }: { iPhone: boolean; standalone: boolean }) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
    iPhone
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
      : 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36',
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('display-mode') ? standalone : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <NotificationsPage />
    </QueryClientProvider>,
  )
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  window.localStorage.clear()
  stubDevice({ iPhone: false, standalone: true })
  mocks.appId.mockReturnValue(APP_ID)
  mocks.fetchMyPushSubscriptions.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings → Ειδοποιήσεις', () => {
  it('without VITE_ONESIGNAL_APP_ID: «not available», no button, the SDK never loads', async () => {
    mocks.appId.mockReturnValue(null)
    open()
    expect(await screen.findByText(TEXT.unavailable)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(mocks.startPush).not.toHaveBeenCalled()
    expect(mocks.fetchMyPushSubscriptions).not.toHaveBeenCalled()
  })

  it('iOS outside the installed app: the install instruction, and no SDK', async () => {
    stubDevice({ iPhone: true, standalone: false })
    open()
    expect(await screen.findByText(TEXT.needsInstall)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(mocks.startPush).not.toHaveBeenCalled()
  })

  it('off → «Ενεργοποίηση» registers this device first, then it is on, then the test push', async () => {
    const sdk = fakeSdk({ id: DEVICE, optedIn: false })
    mocks.startPush.mockResolvedValue(sdk.api)
    mocks.registerPushSubscription.mockImplementation(() => {
      // The row is mine from now on; the device is still off (no opt-in before this answer).
      expect(sdk.subscription.optIn).not.toHaveBeenCalled()
      mocks.fetchMyPushSubscriptions.mockResolvedValue([row(DEVICE)])
      return Promise.resolve({ id: row(DEVICE).id, moved: true })
    })
    mocks.requestTestPush.mockResolvedValue({
      messageId: '00000000-0000-4000-8000-0000000e0001',
      queued: true,
      replayed: false,
      reason: null,
    })
    open()
    expect(await screen.findByText(TEXT.off)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: TEXT.enable }))
    // The permission prompt is asked inside the tap itself (iOS).
    expect(sdk.requestPermission).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(TEXT.on)).toBeInTheDocument()
    expect(mocks.registerPushSubscription).toHaveBeenCalledWith(DEVICE)
    expect(sdk.subscription.optIn).toHaveBeenCalledTimes(1)
    expect(sdk.login).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: TEXT.test }))
    expect(await screen.findByText(TEXT.testSent)).toBeInTheDocument()
    expect(mocks.requestTestPush).toHaveBeenCalledWith(BUSINESS_ID)
  })

  it('a failed register: the device is not turned on, the failure is shown, «Ενεργοποίηση» stays', async () => {
    const sdk = fakeSdk({ id: DEVICE, optedIn: false })
    mocks.startPush.mockResolvedValue(sdk.api)
    mocks.registerPushSubscription.mockRejectedValue(new Error('offline'))
    open()
    fireEvent.click(await screen.findByRole('button', { name: TEXT.enable }))

    expect(await screen.findByText(TEXT.registerFailed)).toBeInTheDocument()
    expect(sdk.subscription.optIn).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: TEXT.enable })).toBeEnabled()
  })

  it('opted in, but the row is someone else’s: off for me', async () => {
    const sdk = fakeSdk({ id: DEVICE, optedIn: true })
    void sdk.requestPermission()
    mocks.startPush.mockResolvedValue(sdk.api)
    mocks.fetchMyPushSubscriptions.mockResolvedValue([])
    open()
    expect(await screen.findByText(TEXT.off)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: TEXT.test })).toBeNull()
  })

  it('the test push when the server finds none of my devices asks to turn them on here', async () => {
    const sdk = fakeSdk({ id: DEVICE, optedIn: true })
    void sdk.requestPermission()
    mocks.startPush.mockResolvedValue(sdk.api)
    mocks.fetchMyPushSubscriptions.mockResolvedValue([row(DEVICE)])
    mocks.requestTestPush.mockResolvedValue({
      messageId: null,
      queued: false,
      replayed: false,
      reason: 'no_subscription',
    })
    open()
    fireEvent.click(await screen.findByRole('button', { name: TEXT.test }))
    await waitFor(() => expect(screen.getByText(TEXT.testNotRegistered)).toBeInTheDocument())
  })
})
