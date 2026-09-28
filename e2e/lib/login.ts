import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, type Page } from '@playwright/test'
import { deleteMessagesTo, waitForLoginCode } from './mailpit'

/** The screen texts the sign-in helpers rely on (el.json, `pro.login.*`). */
export const LOGIN_TEXT = {
  emailLabel: 'Email',
  sendCode: 'Στείλε μου κωδικό',
  neutral: 'Αν το email έχει λογαριασμό, σου στείλαμε κωδικό.',
  codeLabel: 'Κωδικός 6 ψηφίων',
  verify: 'Σύνδεση',
} as const

const LOCK_ROOT = join(tmpdir(), 'anaklo-e2e-locks')
const LOCK_STALE_MS = 120_000
const LOCK_WAIT_MS = 90_000

/**
 * Auth keeps ONE pending code per user: a second request (another browser project, a parallel
 * worker) replaces the first, and both would read one mailbox. So everything between "empty the
 * mailbox" and "code accepted" runs under a per-email lock shared by all workers on this machine.
 */
export async function withEmailLock<T>(email: string, work: () => Promise<T>): Promise<T> {
  await mkdir(LOCK_ROOT, { recursive: true })
  const lock = join(LOCK_ROOT, encodeURIComponent(email.toLowerCase()))
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(lock) // atomic: fails with EEXIST while another worker holds the lock
      break
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const since = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      )
      if (since > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true })
      else if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the lock of ${email}`, { cause: error })
      } else await delay(200)
    }
  }
  try {
    return await work()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

/** Asks for a code on /app/login; returns once the (neutral) confirmation shows. */
export async function requestCode(page: Page, email: string): Promise<void> {
  await page.goto('/app/login')
  await page.getByLabel(LOGIN_TEXT.emailLabel).fill(email)
  await page.getByRole('button', { name: LOGIN_TEXT.sendCode }).click()
  await expect(page.getByText(LOGIN_TEXT.neutral)).toBeVisible()
}

/** The whole sign-in (ADR-0009 §1): email → code from Mailpit → leaves the login screen. */
export async function signInWithEmailCode(page: Page, email: string): Promise<void> {
  await withEmailLock(email, async () => {
    await deleteMessagesTo(email)
    await requestCode(page, email)
    const code = await waitForLoginCode(email)
    await page.getByLabel(LOGIN_TEXT.codeLabel).fill(code)
    await page.getByRole('button', { name: LOGIN_TEXT.verify, exact: true }).click()
    await expect(page).not.toHaveURL(/\/app\/login/)
  })
}
