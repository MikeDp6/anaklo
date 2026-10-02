/**
 * One sign-out for the button, the 30-day inactivity guard and revoked sessions (ADR-0009 §19,
 * ADR-0010 §2). `local` by default: shop phones are shared, so signing out ends only this
 * device's session. `global` is for "Sign out of all devices" (Settings → Security, step 1.7).
 */
export type SignOutScope = 'local' | 'global'

/**
 * The Auth calls behind a scope. `others` ends every session of the user except this one and
 * keeps this one when Auth does not confirm; `local` ends this one (supabase-js forgets it even
 * when Auth does not answer). «All devices» = `others`, then `local`.
 */
export type AuthSignOutScope = 'local' | 'others'

export interface SignOutOptions {
  readonly scope?: SignOutScope
}

export interface SignOutResult {
  /**
   * `local`: false when Auth did not confirm (e.g. offline); this device is signed out either way.
   * `global`: false when Auth did not confirm that the OTHER sessions ended; then this device is
   * still signed in and nothing else was done but the push rows (the user can try again).
   */
  readonly ok: boolean
}

export interface SignOutDeps {
  /**
   * Stops push to this device for the user who leaves: `OneSignal.User.PushSubscription.optOut()`
   * and `unregister_push_subscription` (ADR-0010 §7), bounded in time. Never throws; if it did,
   * the sign-out would still go on.
   */
  optOutPush(): Promise<void>
  /**
   * «All devices» only (contract 1.7 §6.7, 1.5 D13): `unregister_push_subscription(p_all => true)`
   * deletes every push row of the user, also when this device never registered. Bounded in time;
   * never throws (if it did, the sign-out would still go on).
   */
  unregisterAllPush(): Promise<void>
  signOutOfSupabase(scope: AuthSignOutScope): Promise<SignOutResult>
  /** Forgets the device's own traces of the session (last activity, pending sign-in). */
  clearDeviceState(): void
}

/** Runs a push step to its end (or its bound); a failure, also a synchronous one, never blocks. */
async function settle(step: () => Promise<void>): Promise<void> {
  await Promise.allSettled([Promise.resolve().then(step)])
}

export async function runSignOut(
  deps: SignOutDeps,
  { scope = 'local' }: SignOutOptions = {},
): Promise<SignOutResult> {
  if (scope === 'global') {
    // «All devices» (contract 1.7 §6.7, review fix): every push row of the user goes first, while
    // the session exists (a signed-out lost phone must not keep receiving bookings). Then Auth
    // ends every OTHER session; this one stays until Auth confirms, so a failure (offline, 5xx) is
    // reported on the Security page with this device still signed in, and the user can try again.
    // Only then this device signs out as below: the end state is every session ended.
    await settle(() => deps.unregisterAllPush())
    const others = await deps.signOutOfSupabase('others')
    if (!others.ok) return { ok: false }
  }
  // This device: push first, while the session still exists (its push_subscriptions row can go
  // only now). A failure never blocks.
  await settle(() => deps.optOutPush())
  try {
    const local = await deps.signOutOfSupabase('local')
    // «All devices» succeeded once the other sessions ended; this one is forgotten either way.
    return scope === 'global' ? { ok: true } : local
  } finally {
    deps.clearDeviceState()
  }
}
