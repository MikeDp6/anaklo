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
  pick,
  readEnvFile,
  readSecretEnvFile,
  requireDevProjectRef,
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
