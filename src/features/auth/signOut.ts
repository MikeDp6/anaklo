/**
 * One sign-out for the button, the 30-day inactivity guard and revoked sessions (ADR-0009 §19,
 * ADR-0010 §2). `local` by default: shop phones are shared, so signing out ends only this
 * device's session. `global` is for "Sign out of all devices" (Settings → Security, step 1.7).
 */
export type SignOutScope = 'local' | 'global'

export interface SignOutOptions {
  readonly scope?: SignOutScope
}

export interface SignOutResult {
  /** False when Auth did not confirm (e.g. offline). The device is signed out either way. */
  readonly ok: boolean
}

export interface SignOutDeps {
  /**
   * Stops push to this device for the user who leaves: `OneSignal.User.PushSubscription.optOut()`
   * (from 1.5a also `unregister_push_subscription`). Never throws.
   */
  optOutPush(): Promise<void>
  signOutOfSupabase(scope: SignOutScope): Promise<SignOutResult>
  /** Forgets the device's own traces of the session (last activity, pending sign-in). */
  clearDeviceState(): void
}

export async function runSignOut(
  deps: SignOutDeps,
  { scope = 'local' }: SignOutOptions = {},
): Promise<SignOutResult> {
  // Push first, while the session still exists (from 1.5a its push_subscriptions row goes too).
  await deps.optOutPush()
  try {
    return await deps.signOutOfSupabase(scope)
  } finally {
    deps.clearDeviceState()
  }
}
