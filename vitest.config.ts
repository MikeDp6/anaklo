import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

// Tests run in UTC so that hidden dependencies on the machine's time zone
// (the dev machine is in Europe/Athens) fail loudly. See CLAUDE.md > Δοκιμές.
process.env.TZ = 'UTC'

export default defineConfig((configEnv) =>
  mergeConfig(
    viteConfig(configEnv),
    defineConfig({
      test: {
        environment: 'jsdom',
        include: [
          'src/**/*.test.{ts,tsx}',
          'supabase/functions/_shared/**/*.test.ts',
          'edge/**/*.test.ts',
          'scripts/**/*.test.mjs',
          // Unit tests of the e2e helpers (the TOTP generator); Playwright runs only *.spec.ts.
          'e2e/lib/**/*.test.ts',
        ],
        setupFiles: ['src/test/setup.ts'],
        env: { TZ: 'UTC' },
        restoreMocks: true,
      },
    }),
  ),
)
