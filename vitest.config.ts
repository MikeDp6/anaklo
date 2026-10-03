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
        // Unit tests never reach a Supabase: the pro client only needs well-formed public values to
        // load. Fixed here so the suite does not depend on a developer's .env.local (CI has none).
        env: {
          TZ: 'UTC',
          VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
          VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_vitest-placeholder',
        },
        restoreMocks: true,
      },
    }),
  ),
)
