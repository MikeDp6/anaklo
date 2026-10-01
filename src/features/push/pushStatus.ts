/**
 * What Settings → «Ειδοποιήσεις» says about this device (contract 1.5 §4.1, ADR-0010 §7).
 * - `unavailable`: no OneSignal app id here (locally until 1.10): the SDK never loads;
 * - `needsInstall`: iOS outside the installed app (push works only there);
 * - `loading`, `failed` (the SDK or the enable failed), `registerFailed` (the row was not written);
 * - `unsupported`, `denied`, `off`, and `on`: permission granted, opted in, AND this device's
 *   subscription id is one of MY `push_subscriptions` rows (an opted-in device whose row belongs
 *   to someone else, or to nobody, is not on for me).
 */
export type PushStatus =
  | 'unavailable'
  | 'needsInstall'
  | 'loading'
  | 'unsupported'
  | 'denied'
  | 'off'
  | 'on'
  | 'failed'
  | 'registerFailed'

export interface PushFacts {
  readonly supported: boolean
  /** The browser's `Notification.permission`, or null where the API does not exist. */
  readonly permission: NotificationPermission | null
  readonly optedIn: boolean
  /** `OneSignal.User.PushSubscription.id`, or null before OneSignal has created it. */
  readonly subscriptionId: string | null
}

export type DevicePushStatus = Extract<PushStatus, 'unsupported' | 'denied' | 'off' | 'on'>

/** OneSignal ids are UUIDs; the server stores them in lower case. */
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function pushStatus(facts: PushFacts, registeredIds: readonly string[]): DevicePushStatus {
  const { supported, permission, optedIn, subscriptionId } = facts
  if (!supported || permission === null) return 'unsupported'
  if (permission === 'denied') return 'denied'
  if (permission !== 'granted' || !optedIn || subscriptionId === null) return 'off'
  return registeredIds.some((id) => sameId(id, subscriptionId)) ? 'on' : 'off'
}

/** Where the SDK is on this page (`usePushDevice`). */
export type PushDeviceState =
  | { readonly kind: 'unavailable' | 'needsInstall' | 'loading' | 'failed' }
  | { readonly kind: 'ready'; readonly facts: PushFacts }

/** How the last «Ενεργοποίηση» tap ended (`idle` = none yet, or it worked). */
export type EnableOutcome = 'idle' | 'pending' | 'failed' | 'registerFailed'

export interface NotificationsView {
  readonly status: PushStatus
  /** The one primary action: enable (also retries a failed SDK load) or the test push. */
  readonly action: 'enable' | 'test' | null
}

/**
 * The screen from the device, my rows (`undefined` while they load; a failed read counts as
 * none, so «Ενεργοποίηση» stays possible) and the last enable. A later success wins over an
 * earlier failure: the rows and the device say `on`.
 */
export function notificationsView(input: {
  readonly device: PushDeviceState
  readonly registeredIds: readonly string[] | undefined
  readonly enable: EnableOutcome
}): NotificationsView {
  const { device, registeredIds, enable } = input
  if (device.kind !== 'ready') {
    return { status: device.kind, action: device.kind === 'failed' ? 'enable' : null }
  }
  if (registeredIds === undefined) return { status: 'loading', action: null }
  const status = pushStatus(device.facts, registeredIds)
  if (status === 'on') return { status, action: 'test' }
  if (status !== 'off') return { status, action: null }
  if (enable === 'failed' || enable === 'registerFailed')
    return { status: enable, action: 'enable' }
  return { status, action: 'enable' }
}

export const PUSH_STATUS_MESSAGE = {
  unavailable: 'push.statusUnavailable',
  needsInstall: 'push.statusNeedsInstall',
  loading: 'push.statusLoading',
  off: 'push.statusOff',
  on: 'push.statusOn',
  denied: 'push.statusDenied',
  unsupported: 'push.statusUnsupported',
  failed: 'push.statusFailed',
  registerFailed: 'push.statusRegisterFailed',
} as const satisfies Record<PushStatus, string>

/** What the test button says after `request_test_push` answered (contract 1.5 §4.3). */
export type TestPushMessage = 'push.testSent' | 'push.testNotRegistered' | 'push.testFailed'

export function testPushMessage(result: {
  readonly queued: boolean
  readonly replayed: boolean
  readonly reason: string | null
}): TestPushMessage {
  // `replayed`: a second tap within the same minute finds the test already on its way.
  if (result.queued || result.replayed) return 'push.testSent'
  return result.reason === 'no_subscription' ? 'push.testNotRegistered' : 'push.testFailed'
}
