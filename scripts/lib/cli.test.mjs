// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECT_REF,
  REPO_ROOT,
  UsageError,
  isInside,
  parseSupportInput,
  pick,
  readEnvFile,
  readSecretEnvFile,
  requireDevProjectRef,
  resolveSupabaseTarget,
  localSupabase,
  parseLocalStatus,
} from './cli.mjs'

describe('isInside', () => {
  it('recognises the repository and its sub-paths only', () => {
    expect(isInside(REPO_ROOT, REPO_ROOT)).toBe(true)
    expect(isInside(path.join(REPO_ROOT, 'supabase', 'x.json'), REPO_ROOT)).toBe(true)
    expect(isInside(path.join(REPO_ROOT, '..', 'anaklo-private', 'x.json'), REPO_ROOT)).toBe(false)
    expect(isInside(`${REPO_ROOT}-private${path.sep}x.json`, REPO_ROOT)).toBe(false)
    expect(isInside(path.join(REPO_ROOT, '..foo'), REPO_ROOT)).toBe(true)
  })
})

describe('env files', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'anaklo-env-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses a dotenv file (with a BOM) without touching process.env', () => {
    const file = path.join(dir, 'dev.env')
    writeFileSync(file, '\uFEFF# comment\nPROXY_SECRET="abc"\nEMPTY=\nX_TEST_ONLY=1\n')
    expect(readEnvFile(file)).toEqual({ PROXY_SECRET: 'abc', EMPTY: '', X_TEST_ONLY: '1' })
    expect(process.env.X_TEST_ONLY).toBeUndefined()
    expect(readSecretEnvFile(file)).toEqual(readEnvFile(file))
  })

  it('refuses a secrets file inside the repository', () => {
    expect(() => readSecretEnvFile(path.join(REPO_ROOT, '.env.local'))).toThrow(UsageError)
    expect(() => readSecretEnvFile(path.join(REPO_ROOT, '.env.local'))).toThrow(
      /outside the repository/,
    )
  })

  it('reports a missing file, and accepts no file at all', () => {
    expect(() => readSecretEnvFile(path.join(dir, 'missing.env'))).toThrow(/not found/)
    expect(readSecretEnvFile(undefined)).toEqual({})
  })
})

describe('the dev project ref', () => {
  it('takes the first non-empty source', () => {
    expect(pick('A', [{ A: '  ' }, { A: 'second' }, { A: 'third' }])).toBe('second')
    expect(pick('A', [{}, {}])).toBeUndefined()
  })

  it('is required and must look like a ref', () => {
    expect(requireDevProjectRef([{ SUPABASE_DEV_PROJECT_REF: 'abcdefghijklmnopqrst' }])).toBe(
      'abcdefghijklmnopqrst',
    )
    expect(() => requireDevProjectRef([{}])).toThrow(/Set SUPABASE_DEV_PROJECT_REF/)
    expect(() => requireDevProjectRef([{ SUPABASE_DEV_PROJECT_REF: 'x; rm -rf /' }])).toThrow(
      /not a project ref/,
    )
    expect(PROJECT_REF.test('ABCDEFGHIJKLMNOPQRST')).toBe(false)
  })
})

describe('resolveSupabaseTarget (provisioning, mfa-reset)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'anaklo-target-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** @param {string} text */
  function envFile(text) {
    const file = path.join(dir, 'dev.env')
    writeFileSync(file, text)
    return file
  }
  const REF = 'abcdefghijklmnopqrst'

  it.each([[{ prod: true }], [{ 'project-ref': REF }], [{ 'env-file': 'x.env' }]])(
    'refuses --local with %j before reading the stack',
    (extra) => {
      expect(() => resolveSupabaseTarget({ local: true, prod: false, ...extra })).toThrow(
        /--local cannot be combined/,
      )
    },
  )

  it('needs an explicit --project-ref with --prod', () => {
    const file = envFile(`SUPABASE_DEV_PROJECT_REF=${REF}\nSUPABASE_SECRET_KEY=sb_secret_x\n`)
    expect(() => resolveSupabaseTarget({ local: false, prod: true, 'env-file': file })).toThrow(
      /--prod requires an explicit --project-ref/,
    )
  })

  it('refuses another project without --prod, and a publishable key as the secret', () => {
    const file = envFile(`SUPABASE_DEV_PROJECT_REF=${REF}\nSUPABASE_SECRET_KEY=sb_publishable_x\n`)
    expect(() =>
      resolveSupabaseTarget({
        local: false,
        prod: false,
        'project-ref': 'zzzzzzzzzzzzzzzzzzzz',
        'env-file': file,
      }),
    ).toThrow(/only the dev project/)
    expect(() => resolveSupabaseTarget({ local: false, prod: false, 'env-file': file })).toThrow(
      /publishable key/,
    )
  })

  it('targets the dev project with the secret key of the env file', () => {
    const file = envFile(`SUPABASE_DEV_PROJECT_REF=${REF}\nSUPABASE_SECRET_KEY=sb_secret_x\n`)
    const target = resolveSupabaseTarget({ local: false, prod: false, 'env-file': file })
    expect(target.local).toBe(false)
    expect(target.key).toBe('sb_secret_x')
    expect(target.label).toMatch(/^dev project [a-z0-9]{20}$/)
    expect(target.url).toMatch(/^https:\/\/[a-z0-9]{20}\.supabase\.co$/)
  })
})

describe('parseSupportInput', () => {
  it('trims and checks reason and ticket like record_support_action', () => {
    expect(parseSupportInput({ reason: '  lost phone ', ticket: ' NOUS-12/b ' })).toEqual({
      reason: 'lost phone',
      ticket: 'NOUS-12/b',
    })
    expect(() => parseSupportInput({ reason: 'ok', ticket: 'T' })).toThrow(/--reason/)
    expect(() => parseSupportInput({ reason: 'x'.repeat(401), ticket: 'T' })).toThrow(/--reason/)
    expect(() => parseSupportInput({ reason: 'lost phone' })).toThrow(/--ticket/)
    expect(() => parseSupportInput({ reason: 'lost phone', ticket: '#1' })).toThrow(/--ticket/)
    expect(() => parseSupportInput({ reason: 'lost phone', ticket: 'x'.repeat(41) })).toThrow(
      /--ticket/,
    )
  })
})

describe('localSupabase (supabase status, retried under load)', () => {
  const ok = {
    status: 0,
    stdout:
      'Stopped services: []\n{"API_URL":"http://127.0.0.1:54321","PUBLISHABLE_KEY":"sb_publishable_x","SECRET_KEY":"sb_secret_x"}',
  }
  const failed = { status: 1, stdout: '' }

  it('reads the local address and keys', () => {
    expect(parseLocalStatus(ok)).toEqual({
      apiUrl: 'http://127.0.0.1:54321',
      publishableKey: 'sb_publishable_x',
      secretKey: 'sb_secret_x',
    })
  })

  it('refuses a non-local API URL at once', () => {
    const remote = {
      status: 0,
      stdout: ok.stdout.replace('http://127.0.0.1:54321', 'https://x.supabase.co'),
    }
    expect(() => parseLocalStatus(remote)).toThrow(/non-local/)
  })

  it('retries a failed read twice, then succeeds', () => {
    const answers = [failed, { status: 0, stdout: '{"API_URL":"http://127.0.0.1:54321"}' }, ok]
    /** @type {number[]} */
    const waits = []
    const stack = localSupabase({
      run: () => answers.shift() ?? failed,
      sleep: (ms) => waits.push(ms),
    })
    expect(stack.apiUrl).toBe('http://127.0.0.1:54321')
    expect(waits).toEqual([500, 2000])
  })

  it('gives up after three failed reads', () => {
    let calls = 0
    expect(() =>
      localSupabase({
        run: () => {
          calls += 1
          return failed
        },
        sleep: () => {},
      }),
    ).toThrow(/npm run db:start/)
    expect(calls).toBe(3)
  })
})
