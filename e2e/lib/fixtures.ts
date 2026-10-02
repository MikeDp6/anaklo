import { test as base } from '@playwright/test'
import { engineOf, ownerStatePath } from './authPaths'
import { cancelBookings, collectBookings } from './cleanup'

export { expect } from '@playwright/test'

/** Per-project options, set in playwright.config.ts (and per spec with `test.use`). */
export interface DeviceOptions {
  /**
   * Pretend the page runs as the installed Home Screen app (`navigator.standalone = true`).
   * On for `mobile-safari`, so the pro app is not stopped by its iOS install screen
   * (ADR-0009 §5); the install-screen spec turns it off with `test.use({ standalone: false })`.
   */
  standalone: boolean
  /**
   * `owner`: the test's context starts signed in as the engine's setup owner at `aal2`
   * (`owner-setup-<chrome|webkit>@demo-barber.test`, written by e2e/setup/owner.setup.ts;
   * contract 1.7 §7.4). Every worker of the engine shares that one session: a spec using it never
   * signs out and never runs a critical action (a step-up would rotate the shared session).
   */
  member: 'none' | 'owner'
}

interface AutoFixtures {
  /** Cancels the test's online bookings when it ends, pass or fail (./cleanup.ts). */
  cancelTestBookings: void
}

/**
 * Use this `test` in every spec: Playwright has no init scripts in the config itself, so the
 * `standalone` option is applied here, to every page of the context; and every online booking a
 * test makes is cancelled when it ends, so reruns find the same free times.
 */
export const test = base.extend<DeviceOptions & AutoFixtures>({
  standalone: [false, { option: true }],
  member: ['none', { option: true }],
  storageState: async ({ member }, use, testInfo) => {
    await use(member === 'owner' ? ownerStatePath(engineOf(testInfo.project.name)) : undefined)
  },
  context: async ({ context, standalone }, use) => {
    if (standalone) {
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'standalone', {
          configurable: true,
          get: () => true,
        })
      })
    }
    await use(context)
  },
  cancelTestBookings: [
    async ({ context, request }, use) => {
      const bookings = collectBookings(context)
      await use()
      await cancelBookings(request, await bookings())
    },
    { auto: true },
  ],
})
