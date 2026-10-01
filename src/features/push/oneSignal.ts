import { deviceStorage, readItem, removeItem, writeItem } from '@/features/auth/storage'
import { readOneSignalAppId } from './env'
import type { PushFacts } from './pushStatus'

/**
 * OneSignal Web SDK v16, loaded lazily and only in the pro app (ADR-0010 §1–3). There is no npm
 * package in the bundle: the page SDK comes from OneSignal's CDN when it is needed, and its
 * service worker is imported by our own `/app/sw.js` (scope `/app/`).
 *
 * The app never tells OneSignal who the user is: no `OneSignal.login`, no `external_id`.
 * OneSignal's Identity Verification does not support the Web SDK, so an identity declared here
 * could be claimed by any member from the devtools. Pushes go to subscription ids, and the
 * server decides which subscriptions belong to whom (ADR-0010 §2): the enable registers this
 * device's id for `auth.uid()` (`register_push_subscription`), a sign-out unregisters it.
 */
const SDK_URL = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js'

/**
 * Remembers that the SDK ran on this device, so a push subscription may exist: every later
 * sign-out (also at start-up, before the SDK is loaded) opts it out.
 */
const DEVICE_FLAG_KEY = 'anaklo.pro.oneSignalUsed'

/**
 * Set by a sign-out on a device where the SDK ran, and removed only after `optOut()` succeeded.
 * The device flag cannot say this, because every start writes it again: this marker means the
 * user who left may still be subscribed here. Every later start opts the device out before it
 * hands the SDK to anyone, including a user who signs in on the same page, where neither a
 * reload nor the start-up cleanup runs. The page keeps its own copy for when storage is blocked.
 */
const OPT_OUT_PENDING_KEY = 'anaklo.pro.oneSignalOptOutPending'

/**
 * This device's OneSignal subscription id, remembered by the enable before it registers the id
 * (ADR-0010 §7), so every later sign-out with a session can unregister the row even when the SDK
 * is not loaded in that page. Forgotten once an unregister has answered. The page keeps its own
 * copy for when storage is blocked.
 */
const SUBSCRIPTION_ID_KEY = 'anaklo.pro.pushSubscriptionId'

/** A sign-out must never hang on push (offline, blocked CDN). */
const OPT_OUT_TIMEOUT_MS = 4_000

/**
 * Bound of `register_push_subscription` inside the enable (it holds the push queue meanwhile, so
 * a sign-out waits for it at most this long before it goes on without push).
 */
const REGISTER_TIMEOUT_MS = 8_000

/** Upper bound for the whole push part of a sign-out, including an enable still in progress. */
const SIGN_OUT_PUSH_TIMEOUT_MS = 2 * OPT_OUT_TIMEOUT_MS

/** How long to wait for OneSignal to report this device's subscription id after opting in. */
export const SUBSCRIPTION_ID_TIMEOUT_MS = 10_000

export interface PushSubscriptionState {
  readonly id?: string | null
  readonly optedIn?: boolean
}

/** The payload of `PushSubscription` 'change' events. */
export interface PushSubscriptionChange {
  readonly current: PushSubscriptionState
}

type SubscriptionListener = (change: PushSubscriptionChange) => void

/** The part of the v16 page SDK the app uses. */
export interface OneSignalApi {
  init(options: {
    appId: string
    serviceWorkerPath: string
    serviceWorkerParam: { scope: string }
    allowLocalhostAsSecureOrigin?: boolean
  }): Promise<void>
  Notifications: {
    isPushSupported(): boolean
    requestPermission(): Promise<unknown>
  }
  User: {
    PushSubscription: {
      /** Null until OneSignal has created the subscription (then a 'change' event reports it). */
      readonly id: string | null | undefined
      readonly optedIn: boolean | undefined
      optIn(): Promise<void>
      optOut(): Promise<void>
      addEventListener(event: 'change', listener: SubscriptionListener): void
      removeEventListener(event: 'change', listener: SubscriptionListener): void
    }
  }
}

type OneSignalCallback = (oneSignal: OneSignalApi) => void | Promise<void>

declare global {
  interface Window {
    OneSignalDeferred?: OneSignalCallback[]
  }
}

let sdk: Promise<OneSignalApi> | null = null
let loaded: OneSignalApi | null = null
let optOutPendingInPage = false
let subscriptionIdInPage: string | null = null

/**
 * Bumped by every sign-out. A start or an enable that began before the current value never
 * completes: the user it was for has signed out while it was still in progress.
 */
let signOuts = 0

/**
 * Opt-in, register, opt-out and unregister run one at a time, in the order they were asked for
 * (last one wins): a sign-out's unregister always comes after a registration in progress.
 */
let pushQueue: Promise<unknown> = Promise.resolve()

function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = pushQueue.then(task, task)
  pushQueue = run.catch(() => undefined)
  return run
}

/** The step was dropped because a sign-out happened while it was in progress. */
export class PushCancelled extends Error {
  constructor() {
    super('signed out before the push step completed')
    this.name = 'PushCancelled'
  }
}

/**
 * `register_push_subscription` failed, so the device was not turned on (or was turned off again):
 * it never stays active while its row may still belong to another user (ADR-0010 §7).
 */
export class PushRegisterFailed extends Error {
  constructor(options?: { cause?: unknown }) {
    super('the push subscription was not registered', options)
    this.name = 'PushRegisterFailed'
  }
}

function assertNoSignOutSince(signOutsAtStart: number): void {
  if (signOuts !== signOutsAtStart) throw new PushCancelled()
}

/** The SDK runs in this page or ran on this device before, so a subscription may exist. */
function mayHaveSubscription(): boolean {
  return (
    loaded !== null ||
    sdk !== null ||
    readItem(deviceStorage(), DEVICE_FLAG_KEY) !== null ||
    rememberedSubscriptionId() !== null
  )
}

function markOptOutPending(): void {
  optOutPendingInPage = true
  writeItem(deviceStorage(), OPT_OUT_PENDING_KEY, '1')
}

function isOptOutPending(): boolean {
  return optOutPendingInPage || readItem(deviceStorage(), OPT_OUT_PENDING_KEY) !== null
}

/** Only after `optOut()` succeeded. */
function clearOptOutPending(): void {
  optOutPendingInPage = false
  removeItem(deviceStorage(), OPT_OUT_PENDING_KEY)
}

function rememberSubscriptionId(id: string): void {
  subscriptionIdInPage = id
  writeItem(deviceStorage(), SUBSCRIPTION_ID_KEY, id)
}

function rememberedSubscriptionId(): string | null {
  return readItem(deviceStorage(), SUBSCRIPTION_ID_KEY) ?? subscriptionIdInPage
}

/** Only the id that was unregistered: an enable meanwhile may have remembered another one. */
function forgetSubscriptionId(id: string): void {
  if (subscriptionIdInPage === id) subscriptionIdInPage = null
  if (readItem(deviceStorage(), SUBSCRIPTION_ID_KEY) === id) {
    removeItem(deviceStorage(), SUBSCRIPTION_ID_KEY)
  }
}

/** The id of the SDK loaded in this page, whether or not the device is opted in. */
function loadedSubscriptionId(): string | null {
  const id = loaded?.User.PushSubscription.id
  return isSubscriptionId(id) ? id : null
}

export function loadOneSignal(appId: string): Promise<OneSignalApi> {
  if (!sdk) {
    sdk = injectSdk(appId)
    // A failed load (offline, blocked) may be retried later.
    void sdk.catch(() => {
      sdk = null
    })
  }
  return sdk
}

export function readPushFacts(oneSignal: OneSignalApi): PushFacts {
  const id = oneSignal.User.PushSubscription.id
  return {
    supported: oneSignal.Notifications.isPushSupported(),
    permission: 'Notification' in window ? Notification.permission : null,
    optedIn: oneSignal.User.PushSubscription.optedIn === true,
    subscriptionId: isSubscriptionId(id) ? id : null,
  }
}

function permissionGranted(): boolean {
  return 'Notification' in window && Notification.permission === 'granted'
}

function isSubscriptionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** This device's subscription id, when it is opted in and OneSignal has reported it. */
export function readSubscriptionId(oneSignal: OneSignalApi): string | null {
  const subscription = oneSignal.User.PushSubscription
  return subscription.optedIn === true && isSubscriptionId(subscription.id) ? subscription.id : null
}

/** Calls `listener` on every change of this device's subscription; returns the unsubscribe. */
export function watchSubscription(oneSignal: OneSignalApi, listener: () => void): () => void {
  const onChange: SubscriptionListener = () => listener()
  oneSignal.User.PushSubscription.addEventListener('change', onChange)
  return () => oneSignal.User.PushSubscription.removeEventListener('change', onChange)
}

/**
 * This device's subscription id: at once when OneSignal has it, otherwise from the first
 * 'change' event that carries one. Rejects after `timeoutMs`.
 */
export function waitForSubscriptionId(
  oneSignal: OneSignalApi,
  timeoutMs: number = SUBSCRIPTION_ID_TIMEOUT_MS,
): Promise<string> {
  const subscription = oneSignal.User.PushSubscription
  if (isSubscriptionId(subscription.id)) return Promise.resolve(subscription.id)
  return new Promise<string>((resolve, reject) => {
    const finish = (settle: () => void) => {
      window.clearTimeout(timer)
      subscription.removeEventListener('change', onChange)
      settle()
    }
    const onChange: SubscriptionListener = ({ current }) => {
      const id = current.id
      if (isSubscriptionId(id)) finish(() => resolve(id))
    }
    const timer = window.setTimeout(
      () => finish(() => reject(new Error('OneSignal reported no subscription id'))),
      timeoutMs,
    )
    subscription.addEventListener('change', onChange)
    // The id may have arrived between the first read and the listener.
    const late = subscription.id
    if (isSubscriptionId(late)) finish(() => resolve(late))
  })
}

function injectSdk(appId: string): Promise<OneSignalApi> {
  return new Promise<OneSignalApi>((resolve, reject) => {
    const queue = (window.OneSignalDeferred ??= [])
    queue.push(async (oneSignal) => {
      try {
        await oneSignal.init({
          appId,
          serviceWorkerPath: 'app/sw.js',
          serviceWorkerParam: { scope: '/app/' },
          allowLocalhostAsSecureOrigin: import.meta.env.DEV,
        })
        loaded = oneSignal
        resolve(oneSignal)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('OneSignal init failed'))
      }
    })
    const script = document.createElement('script')
    script.src = SDK_URL
    script.defer = true
    script.onerror = () => reject(new Error('OneSignal SDK did not load'))
    document.head.append(script)
  })
}

/**
 * Loads the SDK for the signed-in user (ADR-0010 §3). Nothing about the user reaches OneSignal.
 *
 * A sign-out always wins over a start in progress: the device flag is written BEFORE the slow
 * part (CDN script, init), so a sign-out or the start-up cleanup meanwhile opts the device out;
 * and a start overtaken by a sign-out rejects with PushCancelled, so its SDK handle never
 * reaches the UI of a user who has left.
 *
 * An opt-out that an earlier sign-out could not finish (slow SDK load, `optOut()` failed) is
 * done here first, so the user who starts now finds notifications off until they tap «Enable»
 * (ADR-0010 §3 step 9). If it fails again, the start fails and the opt-out stays pending.
 */
export async function startPush(appId: string): Promise<OneSignalApi> {
  const signOutsAtStart = signOuts
  writeItem(deviceStorage(), DEVICE_FLAG_KEY, '1')
  const oneSignal = await loadOneSignal(appId)
  return serially(async () => {
    assertNoSignOutSince(signOutsAtStart)
    // Again inside the queue: a sign-out queued before this start has removed it meanwhile.
    writeItem(deviceStorage(), DEVICE_FLAG_KEY, '1')
    if (isOptOutPending()) {
      await withTimeout(oneSignal.User.PushSubscription.optOut(), OPT_OUT_TIMEOUT_MS)
      // A sign-out meanwhile has queued its own opt-out, which now owns the pending marker.
      assertNoSignOutSince(signOutsAtStart)
      clearOptOutPending()
    }
    return oneSignal
  })
}

export interface EnablePushDeps {
  /**
   * `register_push_subscription` for this device's id (the row moves to the caller). Rejects
   * when the row was not written.
   */
  readonly register: (subscriptionId: string) => Promise<unknown>
}

/** Returned by the first step of an enable when the device has no subscription id yet. */
const NEW_SUBSCRIPTION = Symbol('new subscription')

/**
 * The «enable notifications» tap (ADR-0010 §7). Call it straight from the tap handler, before
 * any other await: iOS shows the permission prompt only in response to a tap, and only inside
 * the installed app (ADR-0010 §3). Then, in turn with sign-outs:
 * - the device already has a `PushSubscription.id` (its row may still belong to the user who
 *   used this phone before): `register` FIRST, and `optIn()` only when that worked;
 * - no id yet (a new subscription, so no row): `optIn()`, wait for the id, `register`; when the
 *   id never comes or `register` fails, `optOut()` again.
 * So a device is never active while its row belongs to someone else. Resolves with the id, or
 * null when the permission was not granted. A failed `register` rejects with PushRegisterFailed.
 * A sign-out meanwhile wins: no opt-in after it, and the enable rejects with PushCancelled.
 */
export async function enablePush(
  oneSignal: OneSignalApi,
  { register }: EnablePushDeps,
): Promise<string | null> {
  const signOutsAtStart = signOuts
  await oneSignal.Notifications.requestPermission()
  const subscription = oneSignal.User.PushSubscription
  const first = await serially(async (): Promise<string | null | typeof NEW_SUBSCRIPTION> => {
    assertNoSignOutSince(signOutsAtStart)
    if (!permissionGranted()) return null
    writeItem(deviceStorage(), DEVICE_FLAG_KEY, '1')
    const existing = subscription.id
    if (!isSubscriptionId(existing)) {
      await subscription.optIn()
      return NEW_SUBSCRIPTION
    }
    await registerDevice(register, existing)
    // A sign-out during `register` queued its opt-out and unregister after this step.
    assertNoSignOutSince(signOutsAtStart)
    if (subscription.optedIn !== true) await subscription.optIn()
    // Also after the opt-in: a sign-out meanwhile owns the pending marker, which must stay.
    assertNoSignOutSince(signOutsAtStart)
    clearOptOutPending()
    return existing
  })
  if (first !== NEW_SUBSCRIPTION) return first

  assertNoSignOutSince(signOutsAtStart)
  let id: string
  try {
    id = await waitForSubscriptionId(oneSignal)
  } catch (error) {
    await serially(async () => {
      if (signOuts === signOutsAtStart) await optOutAfterFailedEnable(oneSignal)
    })
    assertNoSignOutSince(signOutsAtStart)
    throw error
  }
  return serially(async () => {
    // A sign-out while the id was on its way has opted the device out already.
    assertNoSignOutSince(signOutsAtStart)
    try {
      await registerDevice(register, id)
    } catch (error) {
      await optOutAfterFailedEnable(oneSignal)
      throw error
    }
    assertNoSignOutSince(signOutsAtStart)
    clearOptOutPending()
    return id
  })
}

/** Remembers the id first: a registration whose answer was lost is still undone at sign-out. */
async function registerDevice(
  register: EnablePushDeps['register'],
  subscriptionId: string,
): Promise<void> {
  rememberSubscriptionId(subscriptionId)
  try {
    await withTimeout(register(subscriptionId), REGISTER_TIMEOUT_MS)
  } catch (error) {
    throw new PushRegisterFailed({ cause: error })
  }
}

/**
 * Turns the device off again after its own opt-in when the enable could not finish. If even that
 * fails, the opt-out stays pending, so the next start turns it off before anything else.
 */
async function optOutAfterFailedEnable(oneSignal: OneSignalApi): Promise<void> {
  markOptOutPending()
  try {
    await withTimeout(oneSignal.User.PushSubscription.optOut(), OPT_OUT_TIMEOUT_MS)
    clearOptOutPending()
  } catch {
    // Pending: the next start, sign-out or start-up cleanup retries it.
  }
}

export interface OptOutPushOptions {
  /**
   * `unregister_push_subscription` for this device's id. Only a sign-out whose session still
   * exists passes it; a cleanup after the session is gone cannot unregister anything.
   */
  readonly unregister?: (subscriptionId: string) => Promise<unknown>
}

/**
 * `OneSignal.User.PushSubscription.optOut()` on every sign-out (ADR-0009 §19, ADR-0010 §2),
 * after any opt-in still in progress: a shared shop phone stops receiving pushes for the user
 * who left. If the SDK is not loaded in this page but ran on the device before (e.g. the 30-day
 * guard signs out at start-up), it is loaded just for the opt-out. The opt-out is marked pending
 * before anything can fail and stays pending until `optOut()` succeeds: the next start (also a
 * sign-in on the same page), sign-out or start-up cleanup retries it, and one still queued runs
 * when the step before it ends.
 *
 * With `unregister` (from 1.5, ADR-0010 §7), the same step also deletes this device's row, at the
 * same time as the opt-out and with the same bound: the remembered id, else the loaded SDK's id;
 * no id known → no call. Never throws and never waits more than SIGN_OUT_PUSH_TIMEOUT_MS.
 */
export async function optOutPush({ unregister }: OptOutPushOptions = {}): Promise<void> {
  signOuts += 1
  if (mayHaveSubscription()) markOptOutPending()
  try {
    await withTimeout(
      serially(() => Promise.all([optOutDevice(), unregisterDevice(unregister)])),
      SIGN_OUT_PUSH_TIMEOUT_MS,
    )
  } catch {
    // Push must never block a sign-out.
  }
}

let retrying: Promise<void> | null = null

/**
 * Retries an opt-out that an earlier sign-out (or a cleanup after a dropped session) could not
 * finish, as soon as any member session is active: every route guard run, so a sign-in on the
 * same page, a navigation or a return to the app. Without it only the Notifications screen
 * (`startPush`) would retry, and a shared shop phone would keep receiving the previous user's
 * pushes while the next user works in Today/Day (ADR-0010 §2). The SDK is loaded just for the
 * opt-out when it is not in the page. Nothing to do (the usual case) → no SDK, no work. Runs in
 * turn with enables and sign-outs, one retry at a time; never throws and never waits more than
 * SIGN_OUT_PUSH_TIMEOUT_MS. Still failing (offline) → stays pending for the next run. The row
 * of the user who left cannot be unregistered with this session: the opted-out device gets no
 * pushes, and the row moves when this device registers again.
 */
export function retryPendingOptOut(): Promise<void> {
  if (!isOptOutPending()) return Promise.resolve()
  retrying ??= withTimeout(serially(optOutDevice), SIGN_OUT_PUSH_TIMEOUT_MS)
    .catch(() => undefined)
    .finally(() => {
      retrying = null
    })
  return retrying
}

async function unregisterDevice(unregister: OptOutPushOptions['unregister']): Promise<void> {
  if (!unregister) return
  const id = rememberedSubscriptionId() ?? loadedSubscriptionId()
  if (id === null) return
  try {
    await withTimeout(unregister(id), OPT_OUT_TIMEOUT_MS)
    forgetSubscriptionId(id)
  } catch {
    // The row stays until this device registers again (it moves) or a membership change drops
    // the user's rows (0007 trigger); the device itself is opted out either way.
  }
}

async function optOutDevice(): Promise<void> {
  if (!isOptOutPending()) return
  try {
    const appId = readOneSignalAppId()
    if (appId) {
      const oneSignal = loaded ?? (await withTimeout(loadOneSignal(appId), OPT_OUT_TIMEOUT_MS))
      await withTimeout(oneSignal.User.PushSubscription.optOut(), OPT_OUT_TIMEOUT_MS)
    }
    clearOptOutPending()
    removeItem(deviceStorage(), DEVICE_FLAG_KEY)
  } catch {
    // Both markers stay: the next start, sign-out or start-up cleanup retries.
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('failed'))
      },
    )
  })
}
