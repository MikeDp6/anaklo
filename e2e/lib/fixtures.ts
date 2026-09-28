import { test as base } from '@playwright/test'

export { expect } from '@playwright/test'

/** Per-project options, set in playwright.config.ts. */
export interface DeviceOptions {
  /**
   * Pretend the page runs as the installed Home Screen app (`navigator.standalone = true`).
   * On for `mobile-safari`, so the pro app is not stopped by its iOS install screen
   * (ADR-0009 §5); the install-screen spec turns it off with `test.use({ standalone: false })`.
   */
  standalone: boolean
}

/**
 * Use this `test` in every spec that opens /app: Playwright has no init scripts in the config
 * itself, so the `standalone` option is applied here, to every page of the context.
 */
export const test = base.extend<DeviceOptions>({
  standalone: [false, { option: true }],
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
})
