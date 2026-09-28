import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const HARDCODED_TIMEZONE = {
  selector: "Literal[value='Europe/Athens']",
  message: 'Never hard-code a time zone. Use businesses.timezone via dates.ts (CLAUDE.md rule 6).',
}

// Import restrictions are regexes, so relative paths and `.ts` extensions are caught too.
// In flat config the last matching block wins for a rule, so every block repeats what it needs.
const ONLY_ZOD_MINI = {
  regex: '^zod(?!/mini$)(/.*)?$',
  message: "Use 'zod/mini' everywhere (ADR-0001).",
}
const NO_SUPABASE_IN_UI = {
  regex: '(^@supabase/)|((^|/)shared/lib/supabase(\\.ts)?$)',
  message: 'Components never call Supabase: data access lives in the feature api.ts (rule 2).',
}
const NO_SUPABASE_ON_BOOKING_PAGE = {
  regex: '(^@supabase/)|((^|/)shared/lib/supabase(\\.ts)?$)',
  message: 'The booking page calls /api with fetch (publicApi.ts), never supabase-js.',
}
const NO_HEAVY_LIBS_ON_BOOKING_PAGE = {
  regex: '^(react-hook-form|@hookform/.*|react-router(/.*)?)$',
  message: 'Keep the booking page ≤ 120 KB: no form library, no router (route.ts).',
}

/**
 * @param {...{ regex: string, message: string }} patterns
 * @returns {import('eslint').Linter.RulesRecord}
 */
const restrict = (...patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
})

export default defineConfig([
  globalIgnores([
    'dist',
    'coverage',
    'playwright-report',
    'test-results',
    'supabase/.temp',
    // wrangler's local state and bundles (`npm run edge:dev`)
    '**/.wrangler',
    'src/shared/lib/database.types.ts',
    // Edge Function entrypoints run on Deno (Deno globals, npm: import map): `npm run fn:check`
    // type-checks and lints them. The pure `_shared` modules stay linted here too.
    'supabase/functions/*/**',
    '!supabase/functions/_shared/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', HARDCODED_TIMEZONE],
      ...restrict(ONLY_ZOD_MINI),
    },
  },
  {
    files: ['src/**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
  },
  // Rule 2: components, pages, hooks and UI never talk to Supabase directly.
  {
    files: ['src/**/*.tsx', 'src/**/hooks/**/*.ts', 'src/**/components/**/*.ts'],
    rules: restrict(ONLY_ZOD_MINI, NO_SUPABASE_IN_UI),
  },
  // Everything the booking page bundles: its entry, its feature, and the shared app/UI code.
  {
    files: [
      'src/app/booking/**/*.{ts,tsx}',
      'src/features/booking/**/*.{ts,tsx}',
      'src/app/shared/**/*.{ts,tsx}',
      'src/shared/ui/**/*.{ts,tsx}',
      'src/shared/i18n/**/*.ts',
    ],
    rules: restrict(ONLY_ZOD_MINI, NO_SUPABASE_ON_BOOKING_PAGE, NO_HEAVY_LIBS_ON_BOOKING_PAGE),
  },
  // Tests may name real time zones as test data (Playwright emulates the visitor's zone).
  {
    files: ['**/*.test.{ts,tsx}', 'e2e/**/*.ts', 'playwright.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: [
      '**/*.{js,mjs}',
      'vite.config.ts',
      'vitest.config.ts',
      'vitest.db.config.ts',
      'playwright.config.ts',
      'e2e/**/*.ts',
      'tests/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
  },
  prettier,
])
