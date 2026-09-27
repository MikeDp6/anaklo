import { defineConfig, devices } from '@playwright/test'

// Mobile viewports only (CLAUDE.md > Δοκιμές). The local Supabase stack must be running
// (`npm run db:start`) because the booking page reads the seeded demo business through /api.
// Playwright WebKit on Windows is not iOS Safari: real-device checks stay manual (SPEC §13).
export default defineConfig({
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
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
