/** What the push test panel says about this device (ADR-0010 §3). */
export type PushStatus =
  'loading' | 'off' | 'on' | 'denied' | 'unsupported' | 'needsInstall' | 'failed'

export interface PushFacts {
  readonly supported: boolean
  /** The browser's `Notification.permission`, or null where the API does not exist. */
  readonly permission: NotificationPermission | null
  readonly optedIn: boolean
}

export function pushStatus({ supported, permission, optedIn }: PushFacts): PushStatus {
  if (!supported || permission === null) return 'unsupported'
  if (permission === 'denied') return 'denied'
  return permission === 'granted' && optedIn ? 'on' : 'off'
}

export const PUSH_STATUS_MESSAGE = {
  loading: 'push.statusLoading',
  off: 'push.statusOff',
  on: 'push.statusOn',
  denied: 'push.statusDenied',
  unsupported: 'push.statusUnsupported',
  needsInstall: 'push.statusNeedsInstall',
  failed: 'push.statusFailed',
} as const satisfies Record<PushStatus, string>
