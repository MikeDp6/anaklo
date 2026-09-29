import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, type Page } from '@playwright/test'
import { deleteMessagesTo, waitForLoginCode } from './mailpit'

/** The screen texts the sign-in helpers rely on (src/shared/i18n/el/pro.json, `login.*`). */
export const LOGIN_TEXT = {
  emailLabel: 'Email',
  sendCode: 'Στείλε μου κωδικό',
  neutral: 'Αν το email έχει λογαριασμό, σου στείλαμε κωδικό.',
  codeLabel: 'Κωδικός 6 ψηφίων',
  verify: 'Σύνδεση',
  resend: 'Στείλε νέο κωδικό',
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

/** Auth's per-address pacing (`[auth.email] max_frequency` of supabase/config.toml). */
const OVER_EMAIL_SEND_RATE_LIMIT = 'over_email_send_rate_limit'
const MAX_CODE_REQUESTS = 5

/**
 * Asks for a code on /app/login; returns once the (neutral) confirmation shows.
 *
 * Auth sends at most one code per address per `max_frequency` (1 s locally). The screen answers a
 * refused request with the same neutral message on purpose (ADR-0009 §4), so no code would ever
 * arrive: when sign-ins of one address follow each other that closely (the next worker takes the
 * lock of withEmailLock right after the previous sign-in), read Auth's own answer and ask again
 * once the interval it names has passed.
 */
export async function requestCode(page: Page, email: string): Promise<void> {
  await page.goto('/app/login')
  await page.getByLabel(LOGIN_TEXT.emailLabel).fill(email)
  // First the email step's button; a retry uses the code step's «Στείλε νέο κωδικό» (the page
  // keeps the pending email, so a reload would open on the code step, not on the email field).
  let send = page.getByRole('button', { name: LOGIN_TEXT.sendCode })
  for (let attempt = 1; ; attempt += 1) {
    const answer = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/auth/v1/otp',
    )
    await send.click()
    const response = await answer
    await expect(page.getByText(LOGIN_TEXT.neutral)).toBeVisible()
    if (response.status() !== 429) return

    // GoTrue answers { code, message } (older versions: { error_code, msg }).
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    const code = body?.code ?? body?.error_code
    if (code !== OVER_EMAIL_SEND_RATE_LIMIT || attempt >= MAX_CODE_REQUESTS) {
      throw new Error(`Auth refused the code for ${email}: ${JSON.stringify(body)}`)
    }
    // «…you can only request this after N seconds»: wait exactly that long (+1 s of rounding).
    const text = body?.message ?? body?.msg
    const message = typeof text === 'string' ? text : ''
    const seconds = Number(/after (\d+) seconds?/.exec(message)?.[1] ?? 1)
    await delay((seconds + 1) * 1000)
    send = page.getByRole('button', { name: LOGIN_TEXT.resend })
  }
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
