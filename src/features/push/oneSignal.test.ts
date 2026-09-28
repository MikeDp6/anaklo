import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as OneSignalModule from './oneSignal'
import type { OneSignalApi, PushSubscriptionChange } from './oneSignal'

// The real module with a fresh state per test; only the app id and the CDN are replaced.
vi.mock('./env', () => ({ readOneSignalAppId: () => '5f0e0d0c-0000-4000-8000-0000000000aa' }))

const FLAG = 'anaklo.pro.oneSignalUsed'
const PENDING = 'anaklo.pro.oneSignalOptOutPending'
const APP_ID = '5f0e0d0c-0000-4000-8000-0000000000aa'
const DEVICE = '8b1f6a52-3c1e-4c0d-9a4e-2f7d1c9b0e11'

let push: typeof OneSignalModule

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface FakeOptions {
  /** What the permission prompt ends with. */
  readonly grant?: NotificationPermission
  readonly requestPermission?: () => Promise<void>
  readonly optIn?: () => Promise<void>
  /** Runs inside `optOut()`; a rejection leaves the device opted in. */
  readonly optOut?: () => Promise<void>
  /** The subscription id OneSignal already knows when the SDK loads. */
  readonly id?: string | null
  readonly optedIn?: boolean
}

/**
 * The page SDK as the app sees it; `calls` keeps the order of the push steps. It also carries
 * `login`/`logout` (which the real SDK has) only to prove that the app never calls them.
 */
function fakeOneSignal(options: FakeOptions = {}) {
  const calls: string[] = []
  const listeners = new Set<(change: PushSubscriptionChange) => void>()
  const notification = { permission: 'default' as NotificationPermission }
  vi.stubGlobal('Notification', notification)
  const identity = { login: vi.fn(), logout: vi.fn() }
  const init = vi.fn(() => Promise.resolve())
  const subscription = {
    id: options.id ?? null,
    optedIn: options.optedIn ?? false,
    optIn: vi.fn(async () => {
      calls.push('optIn')
      await options.optIn?.()
      subscription.optedIn = true
    }),
    optOut: vi.fn(async () => {
      calls.push('optOut')
      await options.optOut?.()
      subscription.optedIn = false
    }),
    addEventListener: (_event: 'change', listener: (change: PushSubscriptionChange) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_event: 'change', listener: (change: PushSubscriptionChange) => void) => {
      listeners.delete(listener)
    },
  }
  const api: OneSignalApi = Object.assign(
    {
      init,
      Notifications: {
        isPushSupported: () => true,
        requestPermission: async () => {
          calls.push('requestPermission')
          await options.requestPermission?.()
          notification.permission = options.grant ?? 'granted'
        },
      },
      User: { PushSubscription: subscription },
    },
    identity,
  )
  /** OneSignal creates the subscription and reports it with a 'change' event. */
  function reportSubscription(id: string) {
    subscription.id = id
    for (const listener of [...listeners]) {
      listener({ current: { id, optedIn: subscription.optedIn } })
    }
  }
  return { api, calls, identity, init, listeners, reportSubscription }
}

/** The CDN script "arrives": OneSignal runs the queued callbacks with the SDK. */
async function sdkArrives(api: OneSignalApi): Promise<void> {
  for (const callback of window.OneSignalDeferred ?? []) await callback(api)
  window.OneSignalDeferred = []
}

async function started(api: OneSignalApi): Promise<OneSignalApi> {
  const start = push.startPush(APP_ID)
  await sdkArrives(api)
  return start
}

beforeEach(async () => {
  vi.resetModules()
  window.OneSignalDeferred = undefined
  document.head.replaceChildren()
  window.localStorage.clear()
  push = await import('./oneSignal')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('startPush', () => {
  it('loads the SDK and claims no identity (no login, no external_id)', async () => {
    const { api, calls, identity, init } = fakeOneSignal()
    await expect(started(api)).resolves.toBe(api)
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceWorkerPath: 'app/sw.js',
        serviceWorkerParam: { scope: '/app/' },
      }),
    )
    expect(identity.login).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(window.localStorage.getItem(FLAG)).toBe('1')
  })

  it('remembers the device before the SDK has loaded, so a cleanup meanwhile opts it out', () => {
    void push.startPush(APP_ID)
    expect(window.localStorage.getItem(FLAG)).toBe('1')
  })

  it('keeps the subscription of a user who is still signed in (the flag alone is no opt-out)', async () => {
    window.localStorage.setItem(FLAG, '1')
    const { api, calls } = fakeOneSignal({ id: DEVICE, optedIn: true })
    await expect(started(api)).resolves.toBe(api)
    expect(calls).toEqual([])
    expect(push.readSubscriptionId(api)).toBe(DEVICE)
  })
})

describe('enablePush (the tap)', () => {
  it('asks first, opts in, and waits for the subscription id OneSignal reports', async () => {
    const { api, calls, identity, listeners, reportSubscription } = fakeOneSignal()
    const oneSignal = await started(api)
    const enable = push.enablePush(oneSignal)
    await vi.waitFor(() => expect(listeners.size).toBe(1))
    reportSubscription(DEVICE)

    await expect(enable).resolves.toBe(DEVICE)
    expect(calls).toEqual(['requestPermission', 'optIn'])
    expect(listeners.size).toBe(0)
    expect(identity.login).not.toHaveBeenCalled()
    expect(push.readSubscriptionId(oneSignal)).toBe(DEVICE)
  })

  it('asks for the permission synchronously, inside the tap handler', async () => {
    const { api, calls } = fakeOneSignal({ id: DEVICE, optedIn: true })
    const enable = push.enablePush(api)
    expect(calls).toEqual(['requestPermission'])
    await expect(enable).resolves.toBe(DEVICE)
  })

  it('uses the id OneSignal already has, and does not opt in twice', async () => {
    const { api, calls } = fakeOneSignal({ id: DEVICE, optedIn: true })
    const oneSignal = await started(api)
    await expect(push.enablePush(oneSignal)).resolves.toBe(DEVICE)
    expect(calls).toEqual(['requestPermission'])
  })

  it('opts a device in again after an earlier sign-out opted it out', async () => {
    const { api, calls } = fakeOneSignal({ id: DEVICE, optedIn: true })
    await started(api)
    await push.optOutPush()
    expect(push.readSubscriptionId(api)).toBeNull()

    const oneSignal = await started(api)
    await expect(push.enablePush(oneSignal)).resolves.toBe(DEVICE)
    expect(calls).toEqual(['optOut', 'requestPermission', 'optIn'])
  })

  it('without the permission: no opt-in and no id', async () => {
    const { api, calls } = fakeOneSignal({ grant: 'denied' })
    const oneSignal = await started(api)
    await expect(push.enablePush(oneSignal)).resolves.toBeNull()
    expect(calls).toEqual(['requestPermission'])
  })

  it('gives up when OneSignal never reports an id, and stops listening', async () => {
    vi.useFakeTimers()
    const { api, listeners } = fakeOneSignal()
    const oneSignal = await started(api)
    const enable = push.enablePush(oneSignal)
    const outcome = expect(enable).rejects.toThrow(/no subscription id/)
    await vi.advanceTimersByTimeAsync(push.SUBSCRIPTION_ID_TIMEOUT_MS)
    await outcome
    expect(listeners.size).toBe(0)
  })
})

describe('a sign-out wins over push in progress', () => {
  it('while the SDK is still loading (first use, no flag before): start cancelled, one opt-out', async () => {
    const { api, calls } = fakeOneSignal()
    const start = push.startPush(APP_ID)
    const signOut = push.optOutPush()
    await sdkArrives(api)

    await expect(start).rejects.toBeInstanceOf(push.PushCancelled)
    await signOut
    expect(calls).toEqual(['optOut'])
    expect(window.localStorage.getItem(FLAG)).toBeNull()
  })

  it('while the permission prompt is open: no opt-in after it', async () => {
    const prompt = deferred()
    const { api, calls } = fakeOneSignal({ requestPermission: () => prompt.promise })
    const oneSignal = await started(api)
    const enable = push.enablePush(oneSignal)
    await push.optOutPush()
    prompt.resolve()

    await expect(enable).rejects.toBeInstanceOf(push.PushCancelled)
    expect(calls).toEqual(['requestPermission', 'optOut'])
    expect(window.localStorage.getItem(FLAG)).toBeNull()
  })

  it('while optIn() runs: the opt-out waits for it and comes after', async () => {
    const optInDone = deferred()
    const { api, calls } = fakeOneSignal({ id: DEVICE, optIn: () => optInDone.promise })
    const oneSignal = await started(api)
    const enable = push.enablePush(oneSignal)
    await vi.waitFor(() => expect(calls).toEqual(['requestPermission', 'optIn']))

    const signOut = push.optOutPush()
    await Promise.resolve()
    expect(calls).toEqual(['requestPermission', 'optIn'])
    optInDone.resolve()
    await signOut
    await expect(enable).rejects.toBeInstanceOf(push.PushCancelled)
    expect(calls).toEqual(['requestPermission', 'optIn', 'optOut'])
    expect(push.readSubscriptionId(oneSignal)).toBeNull()
    expect(window.localStorage.getItem(FLAG)).toBeNull()
  })

  it('when the SDK loads slower than the sign-out timeout: flag kept for a retry', async () => {
    vi.useFakeTimers()
    const { api, calls } = fakeOneSignal()
    const start = push.startPush(APP_ID)
    const signOut = push.optOutPush()
    await vi.advanceTimersByTimeAsync(10_000)
    await signOut // the sign-out went on without push
    expect(window.localStorage.getItem(FLAG)).toBe('1')
    expect(window.localStorage.getItem(PENDING)).toBe('1')

    await sdkArrives(api)
    await expect(start).rejects.toBeInstanceOf(push.PushCancelled)
    expect(calls).toEqual([])

    // The next start-up cleanup (or sign-out) finds the flag and opts the device out.
    await push.optOutPush()
    expect(calls).toEqual(['optOut'])
    expect(window.localStorage.getItem(FLAG)).toBeNull()
    expect(window.localStorage.getItem(PENDING)).toBeNull()
  })

  it('the next user who signs in on the same page starts normally', async () => {
    const { api, calls } = fakeOneSignal()
    const ownerStart = push.startPush(APP_ID)
    const signOut = push.optOutPush()
    const staffStart = push.startPush(APP_ID)
    await sdkArrives(api)

    await expect(ownerStart).rejects.toBeInstanceOf(push.PushCancelled)
    await expect(staffStart).resolves.toBe(api)
    await signOut
    expect(calls).toEqual(['optOut'])
    expect(window.localStorage.getItem(FLAG)).toBe('1')
  })
})

describe('an opt-out that the sign-out could not finish', () => {
  it('is done by the next start on the same page: the next user starts opted out', async () => {
    // Shared shop phone: the page opens after the owner's session was revoked. The cleanup
    // loads the SDK just to opt out, and the load takes longer than the sign-out waits.
    vi.useFakeTimers()
    window.localStorage.setItem(FLAG, '1')
    const { api, calls } = fakeOneSignal({ id: DEVICE, optedIn: true })
    const signOut = push.optOutPush()
    await vi.advanceTimersByTimeAsync(10_000)
    await signOut
    expect(calls).toEqual([])
    expect(window.localStorage.getItem(PENDING)).toBe('1')

    // Staff signs in on the same page (no reload, no start-up cleanup); the SDK arrives.
    const staffStart = push.startPush(APP_ID)
    await sdkArrives(api)
    const oneSignal = await staffStart

    expect(calls).toEqual(['optOut'])
    expect(push.readSubscriptionId(oneSignal)).toBeNull()
    expect(push.readPushFacts(oneSignal).optedIn).toBe(false)
    expect(window.localStorage.getItem(PENDING)).toBeNull()
    expect(window.localStorage.getItem(FLAG)).toBe('1')
  })

  it('when optOut() itself failed at sign-out, the next start retries it', async () => {
    let failures = 1
    const { api, calls } = fakeOneSignal({
      id: DEVICE,
      optedIn: true,
      optOut: () => (failures-- > 0 ? Promise.reject(new Error('offline')) : Promise.resolve()),
    })
    await started(api)
    await push.optOutPush()
    expect(push.readSubscriptionId(api)).toBe(DEVICE)

    await expect(push.startPush(APP_ID)).resolves.toBe(api)
    expect(calls).toEqual(['optOut', 'optOut'])
    expect(push.readSubscriptionId(api)).toBeNull()
    expect(window.localStorage.getItem(PENDING)).toBeNull()
  })

  it('fails the start while it still cannot opt out, and stays pending for the next one', async () => {
    window.localStorage.setItem(FLAG, '1')
    window.localStorage.setItem(PENDING, '1')
    let failures = 1
    const { api, calls } = fakeOneSignal({
      id: DEVICE,
      optedIn: true,
      optOut: () => (failures-- > 0 ? Promise.reject(new Error('offline')) : Promise.resolve()),
    })
    await expect(started(api)).rejects.toThrow('offline')
    expect(push.readSubscriptionId(api)).toBe(DEVICE)
    expect(window.localStorage.getItem(PENDING)).toBe('1')

    await expect(push.startPush(APP_ID)).resolves.toBe(api)
    expect(calls).toEqual(['optOut', 'optOut'])
    expect(push.readSubscriptionId(api)).toBeNull()
    expect(window.localStorage.getItem(PENDING)).toBeNull()
  })

  it('a sign-out during that opt-out cancels the start and opts out once more', async () => {
    window.localStorage.setItem(FLAG, '1')
    window.localStorage.setItem(PENDING, '1')
    const firstOptOut = deferred()
    let optOuts = 0
    const { api, calls } = fakeOneSignal({
      id: DEVICE,
      optedIn: true,
      optOut: () => (optOuts++ === 0 ? firstOptOut.promise : Promise.resolve()),
    })
    const start = push.startPush(APP_ID)
    await sdkArrives(api)
    await vi.waitFor(() => expect(calls).toEqual(['optOut']))

    const signOut = push.optOutPush()
    firstOptOut.resolve()
    await expect(start).rejects.toBeInstanceOf(push.PushCancelled)
    await signOut
    expect(calls).toEqual(['optOut', 'optOut'])
    expect(window.localStorage.getItem(PENDING)).toBeNull()
    expect(window.localStorage.getItem(FLAG)).toBeNull()
  })

  it('is remembered by the page when storage is blocked (private mode)', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const { api, calls } = fakeOneSignal({ id: DEVICE, optedIn: true })
    const ownerStart = push.startPush(APP_ID)
    const signOut = push.optOutPush()
    await vi.advanceTimersByTimeAsync(10_000)
    await signOut
    expect(calls).toEqual([])

    const staffStart = push.startPush(APP_ID)
    await sdkArrives(api)
    await expect(ownerStart).rejects.toBeInstanceOf(push.PushCancelled)
    await expect(staffStart).resolves.toBe(api)
    expect(calls).toEqual(['optOut'])
    expect(push.readSubscriptionId(api)).toBeNull()
  })
})

describe('optOutPush', () => {
  it('does nothing on a device where the SDK never ran', async () => {
    await push.optOutPush()
    expect(window.OneSignalDeferred).toBeUndefined()
    expect(document.head.querySelector('script')).toBeNull()
  })

  it('loads the SDK just to opt out where it ran before (e.g. the 30-day guard at start-up)', async () => {
    window.localStorage.setItem(FLAG, '1')
    const { api, calls, identity } = fakeOneSignal({ id: DEVICE, optedIn: true })
    const signOut = push.optOutPush()
    await vi.waitFor(() => expect(window.OneSignalDeferred).toHaveLength(1))
    await sdkArrives(api)
    await signOut

    expect(calls).toEqual(['optOut'])
    expect(identity.logout).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(FLAG)).toBeNull()
  })
})
