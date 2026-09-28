import { defineConfig, devices } from '@playwright/test'
import type { DeviceOptions } from './e2e/lib/fixtures'

// Mobile viewports only (CLAUDE.md > Δοκιμές). The local Supabase stack must be running
// (`npm run db:start`) because the booking page reads the seeded demo business through /api and
// the pro app signs in the seeded users (codes from the stack's Mailpit).
// Playwright WebKit on Windows is not iOS Safari: real-device checks stay manual (SPEC §13).
export default defineConfig<DeviceOptions>({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    locale: 'el-GR',
    timezoneId: 'Europe/Athens',
  },
  projects: [
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    {
      name: 'mobile-safari',
      // iPhone 14 has no `navigator.standalone`, so /app would show its install screen
      // (ADR-0009 §5). The `test` of e2e/lib/fixtures.ts turns this option into an init script
      // that sets `navigator.standalone = true`; the install-screen spec opts out.
      use: { ...devices['iPhone 14'], standalone: true },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
