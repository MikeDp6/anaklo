import {
  isAuthApiError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  type Factor,
} from '@supabase/supabase-js'
import { z } from 'zod/mini'
import { AuthorizeFactorResult, ManageFactorsResult } from '@fn-shared/member-schemas.ts'
import { throwIfFunctionFailed } from '@/shared/lib/functionError'
import { RpcFailure, throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import { toAal, type Aal } from './mfa-route'

/**
 * The only access to Supabase Auth MFA in the app (contract 1.7 §6.3). Factors are written only
 * here: the first enrolment and every added device after `authorize_factor_change('add')`; a
 * verified factor is removed only through the Edge Function `manage-factors` (never
 * `mfa.unenroll`, a Vitest checks it); `mfa.unenroll` only for the user's own unverified factors
 * before a new enrolment. Secrets, QR codes and URIs are returned to the caller and never stored.
 */

export interface VerifiedFactor {
  readonly id: string
  readonly friendlyName: string
  readonly createdAt: string
}

export type AuthState =
  | { readonly kind: 'active'; readonly aal: Aal; readonly verifiedFactors: VerifiedFactor[] }
  /** The session no longer exists on the server (revoked: role change, «all devices», reset). */
  | { readonly kind: 'revoked' }

export type FactorGrant = z.infer<typeof AuthorizeFactorResult>

export interface TotpEnrollment {
  readonly factorId: string
  /** Only an `<img src>` (never markup); null when it is not an SVG data URI. */
  readonly qrDataUri: string | null
  readonly secret: string
  readonly uri: string
}

export type VerifyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid_code' | 'rate_limited' | 'offline' | 'unknown' }

/** Why an enrolment could not start; `name_taken` sends the wizard back to the name. */
export type EnrollFailureReason = 'name_taken' | 'rate_limited' | 'offline' | 'unknown'

export class EnrollFailure extends Error {
  readonly reason: EnrollFailureReason

  constructor(reason: EnrollFailureReason, options?: { cause?: unknown }) {
    super(`enrolment failed: ${reason}`, options)
    this.name = 'EnrollFailure'
    this.reason = reason
  }
}

/** A function call of this module gives up after this (the answer would be unknown). */
const FUNCTION_TIMEOUT_MS = 15_000

function toVerified(factor: Factor): VerifiedFactor {
  return {
    id: factor.id,
    friendlyName: factor.friendly_name ?? '',
    createdAt: factor.created_at,
  }
}

function verifiedTotp(factors: readonly Factor[] | undefined): VerifiedFactor[] {
  return (factors ?? [])
    .filter((factor) => factor.factor_type === 'totp' && factor.status === 'verified')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map(toVerified)
}

function isRevoked(error: unknown): boolean {
  if (isAuthSessionMissingError(error)) return true
  return isAuthApiError(error) && (error.status === 401 || error.status === 403)
}

/** An Auth error as the failure the screens know: no answer, no session, or anything else. */
function authFailure(error: unknown): RpcFailure {
  if (isAuthRetryableFetchError(error)) return new RpcFailure({ kind: 'offline' }, { cause: error })
  if (isRevoked(error)) return new RpcFailure({ kind: 'unauthorized' }, { cause: error })
  return new RpcFailure({ kind: 'unknown' }, { cause: error })
}

/** The user as GoTrue sees it now (a network call: a revoked session shows here). */
async function currentFactors(): Promise<readonly Factor[]> {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw authFailure(error)
  return data.user.factors ?? []
}

/**
 * The session's level and the user's verified devices, from GoTrue (contract §6.3, D21): the
 * level from the access token, the factors live from `GET /user`, which also notices a revoked
 * session (401/403, `session_not_found`) → `revoked`. Anything else (offline) throws.
 */
export async function fetchAuthState(): Promise<AuthState> {
  const [user, level] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ])
  if (user.error) {
    if (isRevoked(user.error)) return { kind: 'revoked' }
    throw user.error
  }
  if (level.error) {
    if (isRevoked(level.error)) return { kind: 'revoked' }
    throw level.error
  }
  return {
    kind: 'active',
    aal: toAal(level.data.currentLevel),
    verifiedFactors: verifiedTotp(user.data.user.factors),
  }
}

/** The user's verified authenticator devices, oldest first. */
export async function listVerifiedFactors(): Promise<VerifiedFactor[]> {
  return verifiedTotp(await currentFactors())
}

/** Enrolments that were started and never verified (a QR shown, no code typed). */
export async function listUnverifiedFactorIds(): Promise<string[]> {
  return (await currentFactors())
    .filter((factor) => factor.factor_type === 'totp' && factor.status !== 'verified')
    .map((factor) => factor.id)
}

/**
 * Deletes one of the user's own UNVERIFIED factors (before a new enrolment, or «Ξεκίνα από την
 * αρχή»). Refuses a factor GoTrue lists as verified: those go only through `manage-factors`.
 * A factor that is gone already is fine.
 */
export async function unenrollUnverified(factorId: string): Promise<void> {
  const factor = (await currentFactors()).find((candidate) => candidate.id === factorId)
  if (!factor) return
  if (factor.status === 'verified') {
    throw new Error('refusing to unenroll a verified factor: use manage-factors')
  }
  const { error } = await supabase.auth.mfa.unenroll({ factorId })
  if (error) throw authFailure(error)
}

/**
 * Permission for a new device (`authorize_factor_change('add')`, 0009): the first enrolment
 * passes at `aal1`; with a verified device the server wants a fresh code (`stepUp`, the sheet).
 */
export async function authorizeFactorAdd(): Promise<FactorGrant> {
  const { data, error, status } = await supabase.rpc('authorize_factor_change', {
    p_action: 'add',
  })
  throwIfFailed(error, status)
  return AuthorizeFactorResult.parse(data)
}

const EnrolmentBlocked = z.boolean()

/**
 * Whether the caller may not add a device until Nous resets the account (contract 1.9b §2.5,
 * `factor_enrolment_blocked()`, 0012): a device was removed without going through the app and
 * none is left. The caller's own state only; the server decides (rule 13). The loader asks only
 * when it would otherwise send an owner or manager to the enrolment.
 */
export async function fetchEnrolmentBlocked(): Promise<boolean> {
  const { data, error, status } = await supabase.rpc('factor_enrolment_blocked')
  throwIfFailed(error, status)
  return EnrolmentBlocked.parse(data)
}

/** GoTrue's QR is an SVG data URI; anything else is not shown (only the key is). */
export function qrImageSource(value: string): string | null {
  const prefix = /^data:image\/svg\+xml(;[^,]*)?,/i.exec(value)
  if (!prefix) return null
  const payload = value.slice(prefix[0].length)
  // Raw markup (`;utf-8,<svg…`): percent-encode it so a `#` or `%` in the SVG cannot cut the URI.
  if (!payload.includes('<') || /;base64$/i.test(prefix[1] ?? '')) return value
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payload)}`
}

function enrollFailureReason(error: unknown): EnrollFailureReason {
  if (isAuthRetryableFetchError(error)) return 'offline'
  if (isAuthApiError(error)) {
    if (error.code === 'mfa_factor_name_conflict') return 'name_taken'
    if (error.status === 429) return 'rate_limited'
  }
  return 'unknown'
}

/** Starts a new, unverified TOTP factor; `issuer` is what the authenticator app shows. */
export async function enrollTotp(friendlyName: string, issuer: string): Promise<TotpEnrollment> {
  try {
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName,
      issuer,
    })
    if (error) throw new EnrollFailure(enrollFailureReason(error), { cause: error })
    return {
      factorId: data.id,
      qrDataUri: qrImageSource(data.totp.qr_code),
      secret: data.totp.secret,
      uri: data.totp.uri,
    }
  } catch (error) {
    if (error instanceof EnrollFailure) throw error
    throw new EnrollFailure(enrollFailureReason(error), { cause: error })
  }
}

function verifyFailure(error: unknown): VerifyOutcome {
  if (isAuthRetryableFetchError(error)) return { ok: false, reason: 'offline' }
  if (isAuthApiError(error)) {
    if (error.status === 429 || error.code === 'over_request_rate_limit') {
      return { ok: false, reason: 'rate_limited' }
    }
    if (error.code === 'mfa_verification_failed' || error.status === 422) {
      return { ok: false, reason: 'invalid_code' }
    }
  }
  return { ok: false, reason: 'unknown' }
}

async function newChallenge(factorId: string): Promise<{ id: string } | { error: unknown }> {
  try {
    const { data, error } = await supabase.auth.mfa.challenge({ factorId })
    return error ? { error } : { id: data.id }
  } catch (error) {
    return { error }
  }
}

/**
 * A challenge for the code. GoTrue can answer a challenge with a server error when two factors
 * are challenged in the same instant (the unique `mfa_factors.last_challenged_at` of the Auth
 * schema; seen with parallel e2e workers). No code has been checked at that point, so one new
 * challenge is safe.
 */
async function challengeFor(factorId: string): Promise<{ id: string } | { error: unknown }> {
  const first = await newChallenge(factorId)
  if ('error' in first && serverFailed(first.error)) return newChallenge(factorId)
  return first
}

/** A 5xx answer: supabase-js gives it as `AuthRetryableFetchError` (or `AuthApiError`). */
function serverFailed(error: unknown): boolean {
  return (isAuthRetryableFetchError(error) || isAuthApiError(error)) && error.status >= 500
}

async function challengeAndVerify(factorId: string, code: string): Promise<{ error: unknown }> {
  const challenge = await challengeFor(factorId)
  if ('error' in challenge) return { error: challenge.error }
  try {
    const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code })
    return { error }
  } catch (error) {
    return { error }
  }
}

/**
 * Challenge + verify one code. On success GoTrue issues an `aal2` session whose `amr` carries a
 * new `totp` timestamp (day-1 check). An expired challenge gets one new challenge, and so does a
 * challenge that failed on the server (above).
 */
export async function verifyTotp(factorId: string, code: string): Promise<VerifyOutcome> {
  let { error } = await challengeAndVerify(factorId, code)
  if (isAuthApiError(error) && error.code === 'mfa_challenge_expired') {
    ;({ error } = await challengeAndVerify(factorId, code))
  }
  return error ? verifyFailure(error) : { ok: true }
}

/**
 * The code sheet (contract §6.6): verify, then refresh the session so the retried call carries
 * the token with the new `totp` timestamp. The refresh failing (offline) does not undo the
 * verification: the retry then answers for itself.
 */
export async function stepUpVerify(factorId: string, code: string): Promise<VerifyOutcome> {
  const outcome = await verifyTotp(factorId, code)
  if (!outcome.ok) return outcome
  try {
    await supabase.auth.refreshSession()
  } catch {
    // See above.
  }
  return outcome
}

/**
 * Removes a verified device through `manage-factors` (the server checks a fresh code with
 * `authorize_factor_change('remove')` before it uses the admin API). A 403 with a step-up hint
 * becomes a `stepUp` failure, so `withStepUp` opens the sheet and retries once.
 */
export async function removeFactor(factorId: string): Promise<void> {
  const result = await supabase.functions.invoke<unknown>('manage-factors', {
    body: { action: 'remove', factor_id: factorId },
    timeout: FUNCTION_TIMEOUT_MS,
  })
  await throwIfFunctionFailed(result.error)
  if (!ManageFactorsResult.safeParse(result.data).success) {
    throw new RpcFailure({ kind: 'unknown' })
  }
}
