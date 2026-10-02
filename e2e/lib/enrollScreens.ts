import { expect, type Page } from '@playwright/test'
import { factorSecretOf, factorsOf } from './db'
import { nextCode, saveFactor } from './totpStore'

/**
 * The enrolment wizard's screens (contract 1.7 §6.4), shared by the specs that add a device
 * through the app: the first enrolment, «Προσθήκη τώρα» and Ρυθμίσεις → Ασφάλεια. Texts:
 * src/shared/i18n/el/pro.json `mfa.*`.
 */
export const ENROLL_TEXT = {
  deviceName: 'Όνομα συσκευής',
  haveIt: 'Την έχω',
  scanTitle: 'Σκάναρε τον κωδικό QR',
  qrAlt: 'Κωδικός QR για την εφαρμογή κωδικών',
  open: 'Άνοιγμα στην εφαρμογή κωδικών',
  next: 'Επόμενο',
  codeTitle: 'Γράψε τον κωδικό 6 ψηφίων',
  codeLabel: 'Κωδικός 6 ψηφίων',
  confirm: 'Επιβεβαίωση',
} as const

/** «Βήμα N από 3». */
export function stepOf(page: Page, step: number) {
  return page.getByText(`Βήμα ${step} από 3`, { exact: true })
}

/**
 * Step 2: the QR is an `<img>` with GoTrue's SVG data URI, the `otpauth://` link, and the key,
 * which is the secret Auth stored for the user's one unverified factor (named `name`). The spec's
 * authenticator (./totpStore.ts) keeps it. Returns the factor.
 */
export async function readScanStep(
  page: Page,
  user: { email: string; userId: string },
  name: string,
): Promise<string> {
  await expect(stepOf(page, 2)).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: ENROLL_TEXT.scanTitle })).toBeVisible()
  expect(await page.getByRole('img', { name: ENROLL_TEXT.qrAlt }).getAttribute('src')).toMatch(
    /^data:image\/svg\+xml[;,]/,
  )
  expect(await page.getByRole('link', { name: ENROLL_TEXT.open }).getAttribute('href')).toMatch(
    /^otpauth:\/\/totp\//,
  )
  const key = ((await page.getByTestId('enroll-key').textContent()) ?? '').trim()
  expect(key).toMatch(/^[A-Z2-7]{16,}=*$/)

  const pending = (await factorsOf(user.userId)).filter((factor) => factor.status === 'unverified')
  expect(pending.map((factor) => factor.friendly_name)).toEqual([name])
  const factorId = pending[0]?.id ?? ''
  expect(await factorSecretOf(factorId)).toBe(key)
  await saveFactor(user.email, user.userId, { factorId, friendlyName: name, secret: key })
  return factorId
}

/** «Επόμενο» → step 3 → the new device's code → «Επιβεβαίωση». */
export async function confirmNewDevice(page: Page, email: string, factorId: string): Promise<void> {
  await page.getByRole('button', { name: ENROLL_TEXT.next }).click()
  await expect(stepOf(page, 3)).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: ENROLL_TEXT.codeTitle })).toBeVisible()
  await page.getByLabel(ENROLL_TEXT.codeLabel).fill(await nextCode(email, factorId))
  await page.getByRole('button', { name: ENROLL_TEXT.confirm, exact: true }).click()
}
