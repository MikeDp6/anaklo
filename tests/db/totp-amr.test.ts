import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import { msUntilNextStep, totp, totpCounter } from '../../e2e/lib/totp.ts'
import { adminClient, signInAs, type Db } from './lib/localStack.ts'

/**
 * Day-1 gate of step 1.7 (plan §1.7 «Μέρα 1», item 1): the whole fresh-code rule (C6,
 * `private.require_fresh_totp()`) reads the `totp` timestamp of the `amr` claim, so it only works
 * if a NEW verify moves that timestamp forward (GoTrue upserts `mfa_amr_claims.updated_at` on
 * every verify, `models/amr.go` AddClaimToSession) and a plain refresh does not.
 *
 *   sign in by email code (aal1, no totp) → enrol a TOTP factor → challenge + verify (aal2, totp
 *   at T1) → wait ≥ 2 s → refresh only: still T1 → new challenge + verify → refreshSession →
 *   totp at T2 > T1, T2 = the server's now (the token's `iat`), same session.
 *
 * A dedicated synthetic user (created with Auth admin, deleted at the end), never a seed user:
 * the e2e and the other tests/db files sign those in. Local stack only (localStack.ts reads
 * `supabase status` and refuses any non-local URL). The step-1.10 counterpart is the manual check
 * on anaklo-dev. Prints the decoded `amr` before/after (methods and timestamps only: no token,
 * no secret).
 */
const RUN = randomUUID().slice(0, 8)
const EMAIL = `totp-amr-${RUN}@totp-amr.test`
/** Host wait between the two verifies: ≥ 2 s on the server's clock too (both tick alike). */
const WAIT_MS = 2_100
/** How far a totp timestamp may trail the `iat` of a token minted right after the verify. */
const MAX_LAG_S = 5
/** Host clock vs the stack's clock: beyond one TOTP step the codes themselves would fail. */
const MAX_CLOCK_OFFSET_S = 30

const AmrEntry = z.object({ method: z.string(), timestamp: z.number() })
const AccessClaims = z.object({
  sub: z.string(),
  session_id: z.string(),
  iat: z.number(),
  aal: z.string(),
  amr: z.array(AmrEntry),
})
type AccessClaims = z.infer<typeof AccessClaims>

/** The payload of an access token (read, not verified: the stack signed it for this client). */
function claimsOf(accessToken: string): AccessClaims {
  const payload = accessToken.split('.')[1]
  if (!payload) throw new Error('not a JWT')
  const json: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  return AccessClaims.parse(json)
}

function totpAt(claims: AccessClaims): number | undefined {
  return claims.amr.find((entry) => entry.method === 'totp')?.timestamp
}

/** Same as totpAt, for a token that must carry one. */
function requireTotpAt(claims: AccessClaims): number {
  const timestamp = totpAt(claims)
  if (timestamp === undefined) throw new Error('no totp entry in amr')
  return timestamp
}

async function currentClaims(client: Db): Promise<AccessClaims> {
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  if (!data.session) throw new Error('no session')
  return claimsOf(data.session.access_token)
}

async function refreshedClaims(client: Db): Promise<AccessClaims> {
  const { data, error } = await client.auth.refreshSession()
  if (error) throw error
  if (!data.session) throw new Error('refreshSession returned no session')
  return claimsOf(data.session.access_token)
}

/** A new challenge and its verify, as the app's code sheet does. */
async function challengeAndVerify(client: Db, factorId: string, code: string) {
  const challenge = await client.auth.mfa.challenge({ factorId })
  if (challenge.error) throw challenge.error
  return client.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code })
}

let userId: string | undefined

afterAll(async () => {
  if (userId === undefined) return
  // Deleting the user deletes its factors, sessions and amr claims with it.
  const { error } = await adminClient().auth.admin.deleteUser(userId)
  if (error) throw error
})

describe('totp in amr (day-1 gate of step 1.7)', () => {
  it('a new verify moves the totp timestamp forward; a refresh alone keeps it', async () => {
    const created = await adminClient().auth.admin.createUser({
      email: EMAIL,
      email_confirm: true,
    })
    if (created.error) throw created.error
    userId = created.data.user.id

    // Email code only: aal1, an `otp` entry, no `totp`.
    const client = await signInAs(EMAIL)
    const signedIn = await currentClaims(client)
    expect(signedIn.sub).toBe(userId)
    expect(signedIn.aal).toBe('aal1')
    expect(totpAt(signedIn)).toBeUndefined()

    const enrolled = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'totp-amr' })
    if (enrolled.error) throw enrolled.error
    const factorId = enrolled.data.id
    const secret = enrolled.data.totp.secret

    // First verify (it also verifies the new factor): aal2, totp at T1 = the server's now.
    const firstAt = Date.now()
    const first = await challengeAndVerify(client, factorId, totp(secret, { at: firstAt }))
    if (first.error) throw first.error
    const afterFirst = claimsOf(first.data.access_token)
    const t1 = requireTotpAt(afterFirst)
    expect(afterFirst.aal).toBe('aal2')
    expect(afterFirst.session_id).toBe(signedIn.session_id)
    expect(afterFirst.iat - t1).toBeGreaterThanOrEqual(0)
    expect(afterFirst.iat - t1).toBeLessThanOrEqual(MAX_LAG_S)
    const hostOffset = afterFirst.iat - Math.floor(Date.now() / 1000)
    expect(Math.abs(hostOffset), 'host vs stack clock (Docker/WSL2 drift?)').toBeLessThanOrEqual(
      MAX_CLOCK_OFFSET_S,
    )

    await delay(WAIT_MS)

    // A refresh alone keeps aal2 and the OLD timestamp: freshness expires, it is not renewed.
    const refreshedOnly = await refreshedClaims(client)
    expect(refreshedOnly.aal).toBe('aal2')
    expect(refreshedOnly.session_id).toBe(signedIn.session_id)
    expect(requireTotpAt(refreshedOnly)).toBe(t1)
    expect(refreshedOnly.iat).toBeGreaterThanOrEqual(t1 + 2)

    // Second verify on a new challenge. If GoTrue refuses a code already used in this 30 s step,
    // wait for the next step and try again with its code.
    let reusedCode = 'not tried: the wait crossed into a new step'
    let secondAt = Date.now()
    let second = await challengeAndVerify(client, factorId, totp(secret, { at: secondAt }))
    if (totpCounter(secondAt) === totpCounter(firstAt)) {
      reusedCode = second.error
        ? `refused (${second.error.code ?? second.error.name}: ${second.error.message})`
        : 'accepted'
    }
    if (second.error && totpCounter(secondAt) === totpCounter(firstAt)) {
      await delay(msUntilNextStep() + 1_000)
      secondAt = Date.now()
      second = await challengeAndVerify(client, factorId, totp(secret, { at: secondAt }))
    }
    if (second.error) throw second.error
    const afterSecond = claimsOf(second.data.access_token)
    expect(afterSecond.aal).toBe('aal2')
    expect(requireTotpAt(afterSecond)).toBeGreaterThanOrEqual(t1 + 2)

    // …and the token after refreshSession carries it: strictly newer, at the server's now.
    const refreshed = await refreshedClaims(client)
    const t2 = requireTotpAt(refreshed)
    expect(refreshed.aal).toBe('aal2')
    expect(refreshed.sub).toBe(userId)
    expect(refreshed.session_id).toBe(signedIn.session_id)
    expect(t2).toBe(requireTotpAt(afterSecond))
    expect(t2).toBeGreaterThan(t1)
    expect(t2 - t1).toBeGreaterThanOrEqual(2)
    expect(refreshed.iat - t2).toBeGreaterThanOrEqual(0)
    expect(refreshed.iat - t2).toBeLessThanOrEqual(MAX_LAG_S)
    expect(Math.abs(t2 - Date.now() / 1000)).toBeLessThanOrEqual(MAX_CLOCK_OFFSET_S + MAX_LAG_S)

    console.info(
      `[totp-amr] ${JSON.stringify({
        signedIn: { aal: signedIn.aal, amr: signedIn.amr },
        afterFirstVerify: { aal: afterFirst.aal, amr: afterFirst.amr, iat: afterFirst.iat },
        afterRefreshOnly: {
          aal: refreshedOnly.aal,
          amr: refreshedOnly.amr,
          iat: refreshedOnly.iat,
        },
        afterSecondVerify: { aal: afterSecond.aal, amr: afterSecond.amr, iat: afterSecond.iat },
        afterRefreshSession: { aal: refreshed.aal, amr: refreshed.amr, iat: refreshed.iat },
        totpDelta: t2 - t1,
        reusedCodeInSameStep: reusedCode,
        hostClockOffsetSeconds: hostOffset,
      })}`,
    )
  }, 120_000)
})
