import { defineConfig, devices } from '@playwright/test'
import { APP_ORIGIN } from './e2e/lib/authPaths'
import type { DeviceOptions } from './e2e/lib/fixtures'

// Mobile viewports only (CLAUDE.md > Δοκιμές). The local Supabase stack must be running
// (`npm run db:start`) because the booking page reads the seeded demo business through /api and
// the pro app signs in the seeded users (codes from the stack's Mailpit).
// Playwright WebKit on Windows is not iOS Safari: real-device checks stay manual (SPEC §13).
//
// Step 1.7 (contract 1.7 §7.4): owners and managers sign in with a code of an authenticator app
// too. A setup project per engine enrols its own seed owner through the API and writes an `aal2`
// storageState (e2e/.auth/, git-ignored); the specs with `test.use({ member: 'owner' })` start
// from it. The setup runs before every run of its engine (reruns without db:reset, CI retries).

/**
 * Nous's contact on «Χάσατε τη συσκευή σας;» (contract 1.7 D19): the synthetic placeholders of
 * .env.example, unless the environment sets them. A dev server that is already running is reused
 * as it is (locally): it needs them in .env.local or its environment for mfa-enroll.spec.
 */
process.env.VITE_SUPPORT_EMAIL ??= 'support@example.com'
process.env.VITE_SUPPORT_PHONE ??= '+302100000000'

const pixel = devices['Pixel 7']
const iphone = devices['iPhone 14']

export default defineConfig<DeviceOptions>({
  testDir: 'e2e',
  // Specs only: e2e/lib/*.test.ts are Vitest unit tests of the helpers (vitest.config.ts).
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: APP_ORIGIN,
    trace: 'on-first-retry',
    locale: 'el-GR',
    timezoneId: 'Europe/Athens',
  },
  projects: [
    // Either separator: Windows paths use `\` (Playwright also tries the file URL).
    { name: 'setup-chrome', testMatch: /setup[/\\].*\.setup\.ts$/, use: { ...pixel } },
    {
      name: 'setup-webkit',
      testMatch: /setup[/\\].*\.setup\.ts$/,
      use: { ...iphone, standalone: true },
    },
    { name: 'mobile-chrome', dependencies: ['setup-chrome'], use: { ...pixel } },
    {
      name: 'mobile-safari',
      dependencies: ['setup-webkit'],
      // iPhone 14 has no `navigator.standalone`, so /app would show its install screen
      // (ADR-0009 §5). The `test` of e2e/lib/fixtures.ts turns this option into an init script
      // that sets `navigator.standalone = true`; the install-screen spec opts out.
      use: { ...iphone, standalone: true },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: APP_ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
