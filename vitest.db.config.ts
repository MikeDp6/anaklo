import { defineConfig } from 'vitest/config'

// `npm run test:race`: integration tests against the LOCAL Supabase stack, over HTTP with
// supabase-js (tests/db/**). Kept out of `npm test`: they need a running stack
// (`npm run db:start`, then `npm run db:reset` for the seed). URL and keys come from
// `supabase status` at run time (scripts/lib/cli.mjs), never from the repository.
process.env.TZ = 'UTC'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    env: { TZ: 'UTC' },
    // One file at a time: the files share one database and one signed-in seed user.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
