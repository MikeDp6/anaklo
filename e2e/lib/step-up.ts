import { expect, type Locator, type Page } from '@playwright/test'
import { z } from 'zod/mini'
import { nextCode, readStore, type StoredFactor } from './totpStore'

/**
 * The code sheet «Επιβεβαίωση με κωδικό» in the e2e (plan 1.7 «Playwright», contract 1.7 §7.4).
 * The local seed's fresh-code window is 10″ (`private.platform_settings`, seed.sql): before a
 * critical action the spec waits until the session's last code is older than that (+2″ for the
 * clocks), so the server always asks and the sheet always shows; then it answers with the next
 * unused code of ./totpStore.ts. That wait polls the session; it is the only wait of its kind.
 */

export const SEED_FRESH_WINDOW_SECONDS = 10
const CLOCK_MARGIN_SECONDS = 2

/** src/shared/i18n/el/pro.json `stepUp.*` and `mfa.*`. */
export const STEP_UP_TEXT = {
  title: 'Επιβεβαίωση με κωδικό',
  code: 'Κωδικός 6 ψηφίων',
  submit: 'Συνέχεια',
} as const

/** The hints of a 403 that open the sheet (0009 `require_fresh_totp`). */
export const STEP_UP_HINTS = ['aal2_required', 'fresh_totp_required'] as const

const Claims = z.object({
  aal: z.string(),
  amr: z.optional(z.array(z.object({ method: z.string(), timestamp: z.number() }))),
})
export type SessionClaims = z.infer<typeof Claims>

/** The access token of the pro app's session in the page (supabase-js's storage item). */
export async function pageAccessToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!/^sb-.+-auth-token$/.test(key)) continue
      const session: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (typeof session === 'object' && session !== null && 'access_token' in session) {
        return typeof session.access_token === 'string' ? session.access_token : null
      }
    }
    return null
  })
  if (!token) throw new Error('no pro-app session in the page: sign in first')
  return token
}

/** The claims of an access token (read, not verified: the local stack signed it). */
export function claimsOf(accessToken: string): SessionClaims {
  const payload = accessToken.split('.')[1] ?? ''
  return Claims.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
}

/** Epoch seconds of the newest `totp` entry of `amr` (looked up by method, never by position). */
export function totpTimestamp(claims: SessionClaims): number | null {
  const times = (claims.amr ?? [])
    .filter((entry) => entry.method === 'totp')
    .map((entry) => entry.timestamp)
  return times.length > 0 ? Math.max(...times) : null
}

/** Polls until the page session's code is older than the seed's window (+2″). */
export async function waitUntilCodeIsStale(page: Page): Promise<void> {
  const verifiedAt = totpTimestamp(claimsOf(await pageAccessToken(page)))
  if (verifiedAt === null) throw new Error('the page session has no code (not aal2)')
  await expect
    .poll(
      async () => {
        const at = totpTimestamp(claimsOf(await pageAccessToken(page))) ?? 0
        return Date.now() / 1000 - at
      },
      {
        message: `the session's code is older than ${SEED_FRESH_WINDOW_SECONDS}″`,
        intervals: [500],
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(SEED_FRESH_WINDOW_SECONDS + CLOCK_MARGIN_SECONDS)
}

export function stepUpSheet(page: Page): Locator {
  return page.getByRole('dialog', { name: STEP_UP_TEXT.title })
}

/** The stored factor the sheet is set to: the chosen radio, or the only device. */
async function chosenFactor(sheet: Locator, factors: readonly StoredFactor[]) {
  const radios = sheet.getByRole('radio')
  if ((await radios.count()) === 0) {
    if (factors.length !== 1) {
      throw new Error(`the sheet offers one device, the store has ${factors.length}`)
    }
    return factors[0]
  }
  for (const factor of factors) {
    const radio = sheet.getByRole('radio', { name: factor.friendlyName, exact: true })
    if ((await radio.count()) > 0 && (await radio.isChecked())) return factor
  }
  return undefined
}

/**
 * The sheet opened (it must: the spec waited for a stale code), optionally on another device,
 * a code typed, «Συνέχεια», and the sheet closed (the app then retries the action once).
 */
export async function answerStepUp(page: Page, email: string, device?: string): Promise<void> {
  const sheet = stepUpSheet(page)
  await expect(sheet).toBeVisible()
  if (device) await sheet.getByRole('radio', { name: device, exact: true }).check()
  const factors = (await readStore(email))?.factors ?? []
  const factor = await chosenFactor(sheet, factors)
  if (!factor) throw new Error(`the sheet's device is not in the store of ${email}`)
  await sheet.getByLabel(STEP_UP_TEXT.code).fill(await nextCode(email, factor.factorId))
  await sheet.getByRole('button', { name: STEP_UP_TEXT.submit, exact: true }).click()
  await expect(sheet).toHaveCount(0)
}
