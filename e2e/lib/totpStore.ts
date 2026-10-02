import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod/mini'
import { AUTH_DIR } from './authPaths'
import { withFileLock } from './login'
import { msUntilNextStep, totp, totpCounter } from './totp'

/**
 * The "authenticator app" of the synthetic e2e users (contract 1.7 §7.4): one file per user,
 * `e2e/.auth/totp/<email>.json` = `{ userId, factors: [{ factorId, friendlyName, secret,
 * lastStep }] }`, factors in the order they were enrolled (= the app's order, oldest first).
 * Secrets of e2e users only, on the local stack; never logged, never committed (.gitignore).
 *
 * `nextCode` never hands out the same code twice in one 30″ step for a factor (the hosted Auth may
 * refuse a reused code; plan 1.7): it waits for the next step when the factor's last code was of
 * the current one. That computed wait is the only one here.
 */

const TOTP_DIR = path.join(AUTH_DIR, 'totp')

const StoredFactor = z.object({
  factorId: z.string(),
  friendlyName: z.string(),
  secret: z.string(),
  /** The TOTP step (counter) of the last code handed out; -1 = none yet. */
  lastStep: z.int(),
})
export type StoredFactor = z.infer<typeof StoredFactor>

const Store = z.object({ userId: z.string(), factors: z.array(StoredFactor) })
export type TotpStore = z.infer<typeof Store>

function fileOf(email: string): string {
  return path.join(TOTP_DIR, `${encodeURIComponent(email.toLowerCase())}.json`)
}

function lockOf(email: string): string {
  return `totp:${email.toLowerCase()}`
}

async function read(email: string): Promise<TotpStore | null> {
  const text = await readFile(fileOf(email), 'utf8').catch(() => null)
  if (text === null) return null
  const parsed = Store.safeParse(JSON.parse(text))
  return parsed.success ? parsed.data : null
}

async function write(email: string, store: TotpStore): Promise<void> {
  await mkdir(TOTP_DIR, { recursive: true })
  await writeFile(fileOf(email), JSON.stringify(store, null, 2), 'utf8')
}

/** The user's stored factors (null when none were stored). */
export function readStore(email: string): Promise<TotpStore | null> {
  return withFileLock(lockOf(email), () => read(email))
}

/** Adds a factor the test enrolled (by the API, or the secret read from the enrolment screen). */
export function saveFactor(
  email: string,
  userId: string,
  factor: { factorId: string; friendlyName: string; secret: string },
): Promise<void> {
  return withFileLock(lockOf(email), async () => {
    const current = await read(email)
    const kept = current?.userId === userId ? current.factors : []
    await write(email, {
      userId,
      factors: [
        ...kept.filter((stored) => stored.factorId !== factor.factorId),
        { ...factor, lastStep: -1 },
      ],
    })
  })
}

/** Drops one factor (removed through the app) or, without `factorId`, the whole user. */
export function forgetFactors(email: string, factorId?: string): Promise<void> {
  return withFileLock(lockOf(email), async () => {
    const current = await read(email)
    if (!current) return
    if (factorId === undefined) {
      await rm(fileOf(email), { force: true })
      return
    }
    await write(email, {
      ...current,
      factors: current.factors.filter((stored) => stored.factorId !== factorId),
    })
  })
}

/** The stored factor with that device name (the app shows `friendly_name`). */
export async function factorNamed(email: string, friendlyName: string): Promise<StoredFactor> {
  const factor = (await readStore(email))?.factors.find((f) => f.friendlyName === friendlyName)
  if (!factor) throw new Error(`no stored authenticator «${friendlyName}» for ${email}`)
  return factor
}

/**
 * The code the user's authenticator shows now for `factorId`, never one already handed out for
 * that factor: if this step's code was used, it waits for the next step (≤ 30″).
 */
export function nextCode(email: string, factorId: string): Promise<string> {
  return withFileLock(lockOf(email), async () => {
    for (;;) {
      const store = await read(email)
      const factor = store?.factors.find((stored) => stored.factorId === factorId)
      if (!store || !factor) throw new Error(`no stored secret for factor ${factorId} of ${email}`)
      const now = Date.now()
      const step = totpCounter(now)
      if (step > factor.lastStep) {
        await write(email, {
          ...store,
          factors: store.factors.map((stored) =>
            stored.factorId === factorId ? { ...stored, lastStep: step } : stored,
          ),
        })
        return totp(factor.secret, { at: now })
      }
      await delay(msUntilNextStep(now) + 50)
    }
  })
}
