import { AuthUnknownError, isAuthApiError, isAuthRetryableFetchError } from '@supabase/supabase-js'

/**
 * What the login screen says after an Auth call (ADR-0009 §4). The screen must not reveal which
 * emails have an account: success, `otp_disabled` (unknown email, sign-up closed) and
 * `over_email_send_rate_limit` (per-address limit) all get the SAME neutral message and move on to
 * the code step. So does every other error that could depend on the email. Only a network failure
 * and the per-IP limit (`over_request_rate_limit`), which do not depend on the email, say more.
 */
export type LoginMessageKey =
  | 'pro.login.codeSentNeutral'
  | 'pro.login.errorNetwork'
  | 'pro.login.errorTooManyRequests'
  | 'pro.login.errorCodeInvalid'

export interface SendCodeResult {
  /** True when the screen moves on to the code step. */
  readonly codeStep: boolean
  readonly messageKey: LoginMessageKey
}

export interface VerifyCodeResult {
  readonly signedIn: boolean
  readonly messageKey: LoginMessageKey | null
}

const NEUTRAL: SendCodeResult = { codeStep: true, messageKey: 'pro.login.codeSentNeutral' }

/** `error` is what `signInWithOtp` returned (or threw); null means it succeeded. */
export function mapSendCodeError(error: unknown): SendCodeResult {
  if (error === null || error === undefined) return NEUTRAL
  if (isNetworkError(error)) return { codeStep: false, messageKey: 'pro.login.errorNetwork' }
  if (isRequestRateLimit(error)) {
    return { codeStep: false, messageKey: 'pro.login.errorTooManyRequests' }
  }
  return NEUTRAL
}

/** `error` is what `verifyOtp` returned (or threw); null means the user is signed in. */
export function mapVerifyCodeError(error: unknown): VerifyCodeResult {
  if (error === null || error === undefined) return { signedIn: true, messageKey: null }
  if (isNetworkError(error)) return { signedIn: false, messageKey: 'pro.login.errorNetwork' }
  if (isRequestRateLimit(error)) {
    return { signedIn: false, messageKey: 'pro.login.errorTooManyRequests' }
  }
  // Wrong, expired or already used code, and an unknown email, all look the same.
  return { signedIn: false, messageKey: 'pro.login.errorCodeInvalid' }
}

/**
 * No usable answer from Auth: fetch failed (offline), 5xx/gateway (supabase-js wraps both in
 * AuthRetryableFetchError), or a response that was not Auth's JSON (e.g. a proxy error page).
 */
function isNetworkError(error: unknown): boolean {
  return (
    isAuthRetryableFetchError(error) ||
    error instanceof AuthUnknownError ||
    error instanceof TypeError
  )
}

function isRequestRateLimit(error: unknown): boolean {
  return isAuthApiError(error) && error.code === 'over_request_rate_limit'
}
