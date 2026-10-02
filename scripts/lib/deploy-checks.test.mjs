// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildTargetProblems,
  listFiles,
  parseJsonc,
  removeSourceMaps,
  supportContactProblems,
  workerSupabaseUrl,
  workerTargetProblem,
} from './deploy-checks.mjs'

const REF = 'abcdefghijklmnopqrst'
const DEV_URL = `https://${REF}.supabase.co`

const WRANGLER = `// comment with "quotes"
{
  "name": "anaklo-dev", /* block
  comment */
  "assets": { "directory": "../dist", },
  "vars": {
    "APP_ENV": "dev",
    "SUPABASE_URL": "${DEV_URL}", // trailing comment
    "NOTE": "a // inside a string, and a , ] too",
  },
}
`

describe('parseJsonc', () => {
  it('drops comments and trailing commas but keeps // inside strings', () => {
    expect(parseJsonc(WRANGLER)).toEqual({
      name: 'anaklo-dev',
      assets: { directory: '../dist' },
      vars: { APP_ENV: 'dev', SUPABASE_URL: DEV_URL, NOTE: 'a // inside a string, and a , ] too' },
    })
  })

  it('drops a trailing comma that is followed by comments before the bracket', () => {
    const text = ['{ "vars": { "A": "1", },', '  // note', '  /* more */', '}'].join('\n')
    expect(parseJsonc(text)).toEqual({ vars: { A: '1' } })
  })

  it('parses the repository wrangler.jsonc', () => {
    const text = readFileSync(new URL('../../edge/wrangler.jsonc', import.meta.url), 'utf8')
    expect(workerSupabaseUrl(text)).toMatch(/^https:\/\/[a-z0-9]{20}\.supabase\.co$/)
  })

  it('keeps escaped quotes inside strings', () => {
    expect(parseJsonc('{ "a": "say \\"hi\\" // not a comment" }')).toEqual({
      a: 'say "hi" // not a comment',
    })
  })
})

describe('the Worker target', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'anaklo-test-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads vars.SUPABASE_URL', () => {
    expect(workerSupabaseUrl(WRANGLER)).toBe(DEV_URL)
    expect(workerSupabaseUrl('{ "vars": {} }')).toBeUndefined()
  })

  it('accepts only the dev project', () => {
    const file = path.join(dir, 'wrangler.jsonc')
    writeFileSync(file, WRANGLER)
    expect(workerTargetProblem(file, REF)).toBeNull()
    expect(workerTargetProblem(file, 'zyxwvutsrqponmlkjihg')).toMatch(
      /vars\.SUPABASE_URL is "https:\/\/abcdefghijklmnopqrst\.supabase\.co", expected https:\/\/zyxwvutsrqponmlkjihg\.supabase\.co/,
    )
    expect(workerTargetProblem(path.join(dir, 'missing.jsonc'), REF)).toMatch(/^Cannot read/)
  })
})

describe('the build output', () => {
  let dist = ''
  beforeEach(() => {
    dist = mkdtempSync(path.join(tmpdir(), 'anaklo-dist-'))
    mkdirSync(path.join(dist, 'assets'))
    mkdirSync(path.join(dist, 'app'))
    writeFileSync(path.join(dist, 'index.html'), '<script src="/assets/booking.js"></script>')
    writeFileSync(path.join(dist, 'assets', 'booking.js'), 'fetch("/api/rest/v1/rpc/x")')
    writeFileSync(path.join(dist, 'assets', 'booking.js.map'), '{}')
    writeFileSync(path.join(dist, 'assets', 'pro.js'), `createClient("${DEV_URL}")`)
    writeFileSync(path.join(dist, 'assets', 'pro.js.map'), '{}')
    writeFileSync(path.join(dist, 'app', 'index.html'), '<div id="root"></div>')
  })
  afterEach(() => rmSync(dist, { recursive: true, force: true }))

  it('deletes every source map, at any depth', () => {
    const result = removeSourceMaps(dist)
    expect(result.removed.sort()).toEqual(['assets/booking.js.map', 'assets/pro.js.map'])
    expect(result.remaining).toEqual([])
    expect(listFiles(dist).sort()).toEqual([
      'app/index.html',
      'assets/booking.js',
      'assets/pro.js',
      'index.html',
    ])
  })

  it('accepts a bundle that targets the dev project', () => {
    expect(buildTargetProblems(dist, DEV_URL)).toEqual([])
  })

  it('rejects a bundle built with the local stack address', () => {
    writeFileSync(path.join(dist, 'assets', 'pro.js'), 'createClient("http://127.0.0.1:54321")')
    expect(buildTargetProblems(dist, DEV_URL)).toEqual([
      'assets/pro.js points at the local Supabase stack.',
      `No bundle references ${DEV_URL}.`,
    ])
  })
})

describe('the Nous support contact of the build (contract 1.7 D19)', () => {
  it('accepts real-looking values and empty ones', () => {
    expect(supportContactProblems({ email: 'support@nous.gr', phone: '+302610123456' })).toEqual([])
    expect(supportContactProblems({ email: '', phone: '' })).toEqual([])
  })

  it.each([
    ['support@example.com', '+302100000000'],
    ['help@nous.example', ''],
    ['x@shop.test', ''],
    ['x@y.invalid', ''],
  ])('refuses the placeholder address %s', (email, phone) => {
    expect(supportContactProblems({ email, phone })).toEqual([
      expect.stringContaining('placeholder'),
    ])
  })

  it('refuses malformed values', () => {
    expect(supportContactProblems({ email: 'nous', phone: '2610123456' })).toHaveLength(2)
  })
})
