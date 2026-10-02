import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod/mini'
import { localSupabase, pick, readLocalEnv } from '../../scripts/lib/cli.mjs'
import { resetUserFactors } from '../../scripts/lib/mfa-reset.mjs'
import type { Database } from '../../src/shared/lib/database.types.ts'
import { APP_ORIGIN, AUTH_DIR } from './authPaths'
import { withEmailLock } from './login'
import { forgetFactors, nextCode, readStore, saveFactor } from './totpStore'

/**
 * Owner and manager sessions for the e2e (contract 1.7 §7.4, D17), on the LOCAL stack only
 * (`localSupabase()` refuses any non-local URL). Since 1.7 an owner or manager signs in with the
 * email code AND a code of their authenticator; the specs that are not about that start from an
 * `aal2` session made here, through the API: Auth admin mints the email code (`generateLink`,
 * no email), a publishable-key client redeems it, then challenges and verifies a TOTP code of
 * ./totpStore.ts. The session is written exactly as supabase-js stores it (copied from the
 * client's own storage), as a Playwright storageState for the app's origin.
 *
 * Everything for one user runs under its email lock (./login.ts): Auth keeps one pending code
 * per user, and the UI sign-ins of other specs take the same lock.
 *
 * A cached state is refreshed before it is handed out (never reused as it was): a step-up in a
 * page rotates the session's refresh token, and handing out the stale one again would make Auth
 * revoke the whole session (refresh-token reuse detection).
 */

type Db = SupabaseClient<Database>

/** src/features/auth/sessionPolicy.ts: the app ends a session idle for 30 days. */
const LAST_ACTIVITY_KEY = 'anaklo.pro.lastActivityAt'
/** `common:app.name`, the issuer the app enrols with. */
const ISSUER = 'Anaklo'
/** The name a device gets when the spec does not choose one (the app's default for the first). */
export const FIRST_DEVICE = 'Συσκευή 1'
const STATE_DIR = path.join(AUTH_DIR, 'state')
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]']
const IN_MEMORY = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

/** Playwright's storageState shape (cookies unused: the app keeps its session in localStorage). */
export interface StorageState {
  cookies: never[]
  origins: { origin: string; localStorage: { name: string; value: string }[] }[]
}

let stack: ReturnType<typeof localSupabase> | undefined

function local(): ReturnType<typeof localSupabase> {
  stack ??= localSupabase()
  return stack
}

function adminClient(): Db {
  return createClient<Database>(local().apiUrl, local().secretKey, { auth: IN_MEMORY })
}

/** VITE_SUPABASE_URL of the pro app: its host names the storage key (`sb-<host>-auth-token`). */
function appSupabaseUrl(): string {
  const url = pick('VITE_SUPABASE_URL', [process.env, readLocalEnv()]) ?? local().apiUrl
  if (!LOCAL_HOSTS.includes(new URL(url).hostname)) {
    throw new Error(`VITE_SUPABASE_URL is not the local stack (${url}); refusing.`)
  }
  return url
}

interface SessionClient {
  readonly db: Db
  /** What supabase-js stored, key by key, exactly as the app's own client would. */
  readonly items: Map<string, string>
}

/** A publishable-key client that stores its session in memory (optionally a stored one). */
function sessionClient(seed: Iterable<[string, string]> = []): SessionClient {
  const items = new Map(seed)
  const db = createClient<Database>(appSupabaseUrl(), local().publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => void items.set(key, value),
        removeItem: (key) => void items.delete(key),
      },
    },
  })
  return { db, items }
}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`${what}: ${error.message}`)
}

/** The Auth user with this email, or null (0009 `user_id_for_email`, service role). */
export async function findUserId(email: string): Promise<string | null> {
  const { data, error } = await adminClient().rpc('user_id_for_email', { p_email: email })
  fail(`user_id_for_email(${email})`, error)
  return z.nullable(z.string()).parse(data)
}

export async function userIdOf(email: string): Promise<string> {
  const id = await findUserId(email)
  if (!id) throw new Error(`no Auth user ${email} (npm run db:reset?)`)
  return id
}

async function listFactors(userId: string): Promise<{ id: string; status: string }[]> {
  const { data, error } = await adminClient().auth.admin.mfa.listFactors({ userId })
  fail('list factors', error)
  return (data?.factors ?? []).map((factor) => ({ id: factor.id, status: factor.status }))
}

/** The email-code step without an email (hold the email lock): an `aal1` session. */
async function emailSignIn(email: string): Promise<SessionClient> {
  const link = await adminClient().auth.admin.generateLink({ type: 'magiclink', email })
  fail(`generateLink(${email})`, link.error)
  const session = sessionClient()
  const verified = await session.db.auth.verifyOtp({
    email,
    token: link.data.properties?.email_otp ?? '',
    type: 'email',
  })
  fail(`verifyOtp(${email})`, verified.error)
  return session
}

/**
 * A new challenge + verify with the next unused code of `factorId`: the session is `aal2`. Like
 * the app (`src/features/auth/mfaApi.ts`), a challenge the server failed (5xx: two factors
 * challenged in the same instant, with parallel workers) gets one new challenge; no code was
 * checked yet, so the code is still unused.
 */
async function verifyFactor(session: SessionClient, email: string, factorId: string) {
  const code = await nextCode(email, factorId)
  let challenge = await session.db.auth.mfa.challenge({ factorId })
  if ((challenge.error?.status ?? 0) >= 500) {
    challenge = await session.db.auth.mfa.challenge({ factorId })
  }
  fail(`challenge a factor of ${email}`, challenge.error)
  if (!challenge.data) throw new Error(`challenge a factor of ${email}: no challenge`)
  const { error } = await session.db.auth.mfa.verify({
    factorId,
    challengeId: challenge.data.id,
    code,
  })
  fail(`verify a code of ${email}`, error)
}

function statePath(email: string): string {
  return path.join(STATE_DIR, `${encodeURIComponent(email.toLowerCase())}.json`)
}

/** Every factor deleted the way the Nous reset does it, every session revoked (hold the lock). */
async function resetLocked(email: string, userId: string): Promise<void> {
  const admin = adminClient()
  if ((await listFactors(userId)).length > 0) {
    // Grants + audit (record_support_action 'mfa_reset'), deleteFactor, revoke_user_sessions:
    // the 1.9 detector sees every deletion as authorised (plan 1.7 «Playwright»).
    await resetUserFactors(admin, { userId, reason: 'e2e reset', ticket: 'E2E' })
  } else {
    const { error } = await admin.rpc('revoke_user_sessions', { p_user_id: userId })
    fail('revoke_user_sessions', error)
  }
  await forgetFactors(email)
  await rm(statePath(email), { force: true })
}

/** First enrolment through the API (hold the lock; no verified factor left): an `aal2` session. */
async function enrollLocked(email: string, userId: string, name: string): Promise<SessionClient> {
  const session = await emailSignIn(email)
  // The first device needs no fresh code (0009 authorize_factor_change at aal1).
  const grant = await session.db.rpc('authorize_factor_change', { p_action: 'add' })
  fail('authorize_factor_change(add)', grant.error)
  const enrolled = await session.db.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: name,
    issuer: ISSUER,
  })
  fail(`enrol ${email}`, enrolled.error)
  if (!enrolled.data) throw new Error(`enrol ${email}: no factor`)
  await saveFactor(email, userId, {
    factorId: enrolled.data.id,
    friendlyName: name,
    secret: enrolled.data.totp.secret,
  })
  await verifyFactor(session, email, enrolled.data.id)
  return session
}

/**
 * The store knows every verified factor of the user (and stale stored ones are dropped), or the
 * user is reset and enrolled again; then the enrolment's own `aal2` session is returned.
 */
async function ensureEnrolledLocked(
  email: string,
  name: string,
): Promise<{ userId: string; enrolled: SessionClient | null }> {
  const userId = await userIdOf(email)
  const verified = (await listFactors(userId))
    .filter((factor) => factor.status === 'verified')
    .map((factor) => factor.id)
  const store = await readStore(email)
  const stored = store?.userId === userId ? store.factors.map((factor) => factor.factorId) : []
  if (verified.length > 0 && verified.every((id) => stored.includes(id))) {
    for (const id of stored) if (!verified.includes(id)) await forgetFactors(email, id)
    return { userId, enrolled: null }
  }
  await resetLocked(email, userId)
  return { userId, enrolled: await enrollLocked(email, userId, name) }
}

const AccessClaims = z.object({ aal: z.string() })

function aalOf(session: SessionClient): string | null {
  for (const value of session.items.values()) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || !('access_token' in parsed)) continue
      const token = parsed.access_token
      if (typeof token !== 'string') continue
      const payload = token.split('.')[1] ?? ''
      return AccessClaims.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).aal
    } catch {
      // not the session item
    }
  }
  return null
}

async function saveState(email: string, session: SessionClient): Promise<StorageState> {
  if (aalOf(session) !== 'aal2') throw new Error(`the session of ${email} is not aal2`)
  const state: StorageState = {
    cookies: [],
    origins: [
      {
        origin: APP_ORIGIN,
        localStorage: [
          ...[...session.items].map(([name, value]) => ({ name, value })),
          { name: LAST_ACTIVITY_KEY, value: String(Date.now()) },
        ],
      },
    ],
  }
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(statePath(email), JSON.stringify(state), 'utf8')
  return state
}

async function readState(email: string): Promise<Map<string, string> | null> {
  const text = await readFile(statePath(email), 'utf8').catch(() => null)
  if (text === null) return null
  const state = JSON.parse(text) as StorageState
  const items = state.origins.find((origin) => origin.origin === APP_ORIGIN)?.localStorage ?? []
  return new Map(
    items.filter((item) => item.name !== LAST_ACTIVITY_KEY).map((item) => [item.name, item.value]),
  )
}

/**
 * Deletes the Auth account of a SYNTHETIC user an earlier run created (the members spec's
 * invitee), so the next invitation meets a new person again (created by `invite-member`, never
 * signed in). Its memberships go with it (cascade; the 0009 trigger ends its sessions).
 */
export function deleteAuthUser(email: string): Promise<void> {
  return withEmailLock(email, async () => {
    const userId = await findUserId(email)
    if (!userId) return
    const { error } = await adminClient().auth.admin.deleteUser(userId)
    fail(`delete the Auth user ${email}`, error)
    await forgetFactors(email)
    await rm(statePath(email), { force: true })
  })
}

/** Deletes every factor of the user (grants + audit first), revokes every session. */
export function resetFactors(email: string): Promise<void> {
  return withEmailLock(email, async () => resetLocked(email, await userIdOf(email)))
}

/** The user has a verified factor whose secret the store holds (enrols one if not). */
export function ensureEnrolled(email: string, name: string = FIRST_DEVICE): Promise<string> {
  return withEmailLock(email, async () => {
    const { userId, enrolled } = await ensureEnrolledLocked(email, name)
    if (enrolled) await saveState(email, enrolled)
    return userId
  })
}

/**
 * An `aal2` session of the user as a storageState (enrolling first if needed). `fresh` = always a
 * NEW session (two devices of one user, or a session the test will sign out); otherwise the
 * cached one, refreshed, when it still works.
 */
export function aal2State(email: string, options: { fresh?: boolean } = {}): Promise<StorageState> {
  return withEmailLock(email, async () => {
    const { enrolled } = await ensureEnrolledLocked(email, FIRST_DEVICE)
    if (enrolled) return saveState(email, enrolled)
    const cached = options.fresh ? null : await readState(email)
    if (cached) {
      const session = sessionClient(cached)
      const { error } = await session.db.auth.refreshSession()
      if (!error && aalOf(session) === 'aal2') return saveState(email, session)
    }
    const [first] = (await readStore(email))?.factors ?? []
    if (!first) throw new Error(`no stored authenticator for ${email}`)
    const session = await emailSignIn(email)
    await verifyFactor(session, email, first.factorId)
    return saveState(email, session)
  })
}

/**
 * Puts the session into this page (once: a later navigation keeps whatever the app made of it,
 * e.g. a sign-out) and opens «Σήμερα».
 */
export async function useSessionIn(page: Page, state: StorageState): Promise<void> {
  const items = state.origins.find((origin) => origin.origin === APP_ORIGIN)?.localStorage ?? []
  const flag = `e2e.session.${randomUUID()}`
  await page.addInitScript(
    ({ items, flag, origin }) => {
      if (window.location.origin !== origin || sessionStorage.getItem(flag)) return
      for (const { name, value } of items) localStorage.setItem(name, value)
      sessionStorage.setItem(flag, '1')
    },
    { items, flag, origin: APP_ORIGIN },
  )
  await page.goto('/app')
  await expect(page.getByRole('heading', { level: 1, name: 'Σήμερα' })).toBeVisible()
}

/** An owner/manager signed in at `aal2` in this page, on «Σήμερα» (contract 1.7 §7.4). */
export async function signInAal2(
  page: Page,
  email: string,
  options: { fresh?: boolean } = {},
): Promise<void> {
  await useSessionIn(page, await aal2State(email, options))
}

/**
 * A critical RPC with a code verified just now (a set-up or clean-up the screen under test does
 * not make, e.g. the identity spec putting its old address back after a failed run).
 */
export function freshRpc(
  email: string,
  fn: 'change_business_identity',
  args: Database['public']['Functions']['change_business_identity']['Args'],
): Promise<unknown> {
  return withEmailLock(email, async () => {
    await ensureEnrolledLocked(email, FIRST_DEVICE)
    const [first] = (await readStore(email))?.factors ?? []
    if (!first) throw new Error(`no stored authenticator for ${email}`)
    const session = await emailSignIn(email)
    try {
      await verifyFactor(session, email, first.factorId)
      const { data, error } = await session.db.rpc(fn, args)
      fail(fn, error)
      return data
    } finally {
      await session.db.auth.signOut({ scope: 'local' })
    }
  })
}
