import { optOutPush } from '@/features/push/oneSignal'
import {
  getSessionUser,
  sendEmailCode,
  signOutOfSupabase,
  verifyEmailCode,
  type SessionUser,
} from './api'
import {
  mapSendCodeError,
  mapVerifyCodeError,
  type SendCodeResult,
  type VerifyCodeResult,
} from './loginErrors'
import {
  clearPendingEmail,
  readPendingEmail,
  readPendingSignIn,
  restorePendingSignIn,
  savePendingEmail,
} from './pendingEmail'
import { clearLastActivity, recordActivity, writeLastActivity } from './sessionPolicy'
import { runSignOut, type SignOutOptions, type SignOutResult } from './signOut'
import { deviceStorage } from './storage'

/** Sign-in, sign-out and the session guard of the pro app, wired to the real device. */

export function signOut(options?: SignOutOptions): Promise<SignOutResult> {
  return runSignOut({ optOutPush, signOutOfSupabase, clearDeviceState }, options)
}

/**
 * The device-side part of a sign-out, for when supabase-js has already dropped the session
 * (revoked session, another tab, or simply signed out). Idempotent. It keeps a pending sign-in:
 * that belongs to someone signing in right now (ADR-0009 §5).
 */
export async function cleanUpDevice(): Promise<void> {
  await optOutPush()
  clearLastActivity(deviceStorage())
}

/** After an explicit sign-out nothing of the session stays on a shared phone. */
function clearDeviceState(): void {
  const storage = deviceStorage()
  clearLastActivity(storage)
  clearPendingEmail(storage)
}

/**
 * The current user if the session is present and not idle for more than 30 days. A stale
 * session is signed out here (ADR-0009 §19). Otherwise the activity timestamp moves to now.
 */
export async function currentActiveUser(now = new Date()): Promise<SessionUser | null> {
  const user = await getSessionUser()
  if (!user) {
    // Nothing to sign out of, but a dropped session may have left push opted in on this device.
    await cleanUpDevice()
    return null
  }
  if (recordActivity(deviceStorage(), now) === 'stale') {
    await signOut()
    return null
  }
  return user
}

export function loadPendingEmail(now = new Date()): string | null {
  return readPendingEmail(deviceStorage(), now)
}

export function forgetPendingEmail(): void {
  clearPendingEmail(deviceStorage())
}

/**
 * Saves the pending email BEFORE asking for the code (ADR-0009 §5), with a new expiry. When no
 * code was requested after all (network, per-IP limit), only this attempt is undone: a resend
 * from the code step puts back the earlier entry for the same email as it was, because the code
 * sent before is still valid and the screen stays on the code step; a first request (nothing
 * pending for this email) forgets it. The entry goes on success or expiry only.
 */
export async function requestLoginCode(email: string): Promise<SendCodeResult> {
  const storage = deviceStorage()
  const earlier = readPendingSignIn(storage, new Date())
  savePendingEmail(storage, email, new Date())
  const result = mapSendCodeError(await sendEmailCode(email))
  if (!result.codeStep) {
    if (earlier?.email === email) restorePendingSignIn(storage, earlier)
    else clearPendingEmail(storage)
  }
  return result
}

export async function confirmLoginCode(email: string, code: string): Promise<VerifyCodeResult> {
  const result = mapVerifyCodeError(await verifyEmailCode(email, code))
  if (result.signedIn) {
    const storage = deviceStorage()
    clearPendingEmail(storage)
    // A new session starts its 30 days now, whatever an earlier user left on a shared phone.
    writeLastActivity(storage, new Date())
  }
  return result
}
