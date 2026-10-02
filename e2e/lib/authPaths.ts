import path from 'node:path'
import { REPO_ROOT } from '../../scripts/lib/cli.mjs'

/**
 * Where the step-1.7 e2e keep what makes a synthetic user signed in (contract 1.7 §7.4): the
 * Playwright storageState files and the authenticator secrets of the e2e users, all under
 * `e2e/.auth/` (git-ignored; the local stack only, never a real user). No heavy imports here:
 * playwright.config.ts reads it.
 */

/** The pro app's origin in the e2e: `use.baseURL` of playwright.config.ts. */
export const APP_ORIGIN = 'http://localhost:5173'

export const AUTH_DIR = path.join(REPO_ROOT, 'e2e', '.auth')

/** The engine a project runs on: the setup and the spec projects of one engine share users. */
export type Engine = 'chrome' | 'webkit'

export function engineOf(projectName: string): Engine {
  return /safari|webkit/.test(projectName) ? 'webkit' : 'chrome'
}

/**
 * The owner whose `aal2` session the specs with `member: 'owner'` start from (seed …a011/…a012:
 * owners of demo-barber without a staff row). One per engine, so the two projects never share
 * a session.
 */
export function setupOwnerEmail(engine: Engine): string {
  return `owner-setup-${engine}@demo-barber.test`
}

/** The storageState file the setup project writes for that owner. */
export function ownerStatePath(engine: Engine): string {
  return path.join(AUTH_DIR, `owner-setup-${engine}.json`)
}
