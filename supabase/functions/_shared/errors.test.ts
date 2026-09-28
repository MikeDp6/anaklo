import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOMAIN_ERROR_CODES, DOMAIN_ERRORS, domainErrorCode, isDomainErrorCode } from './errors.ts'

const ROOT = process.cwd()
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')

function catalogue(locale: 'el' | 'en'): unknown {
  return JSON.parse(
    readFileSync(join(ROOT, 'src', 'shared', 'i18n', locale, 'common.json'), 'utf8'),
  )
}

function lookup(tree: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[key]
        : undefined,
    tree,
  )
}

/** code → name pairs of the LATEST private.raise_domain_error definition in the migrations. */
function sqlDomainErrors(): Record<string, string> {
  const sql = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    .join('\n')
  const definitions = [
    ...sql.matchAll(/function\s+private\.raise_domain_error\s*\([\s\S]*?\n\$\$;/gi),
  ]
  const body = definitions.at(-1)?.[0] ?? ''
  const pairs = [...body.matchAll(/when\s+'(AN\d{3})'\s+then\s+'([a-z_]+)'/g)].map(
    (m): [string, string] => [m[1] ?? '', m[2] ?? ''],
  )
  return Object.fromEntries(pairs)
}

describe('domain error codes', () => {
  it('are AN + three digits with unique snake_case names', () => {
    for (const code of DOMAIN_ERROR_CODES) expect(code).toMatch(/^AN\d{3}$/)
    const names = Object.values(DOMAIN_ERRORS)
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/)
    expect(new Set(names).size).toBe(names.length)
  })

  it('match the SQL list in private.raise_domain_error exactly', () => {
    expect(sqlDomainErrors()).toEqual(DOMAIN_ERRORS)
  })

  it.each(DOMAIN_ERROR_CODES)('%s has a non-empty errors.<code> text in el and en', (code) => {
    for (const locale of ['el', 'en'] as const) {
      const text = lookup(catalogue(locale), ['errors', code])
      expect(typeof text, `${locale}: errors.${code}`).toBe('string')
      expect((text as string).trim()).not.toBe('')
    }
  })
})

describe('domainErrorCode', () => {
  it('reads the code of a PostgREST domain error', () => {
    const postgrestError = { code: 'P0001', message: 'AN001', details: null, hint: 'slot_taken' }
    expect(domainErrorCode(postgrestError)).toBe('AN001')
  })

  it('ignores other SQLSTATEs, unknown codes and missing errors', () => {
    expect(domainErrorCode({ code: '42501', message: 'AN001' })).toBeNull()
    expect(domainErrorCode({ code: 'P0001', message: 'AN999' })).toBeNull()
    expect(domainErrorCode({ code: 'P0001', message: 'toString' })).toBeNull()
    expect(domainErrorCode(null)).toBeNull()
    expect(domainErrorCode(undefined)).toBeNull()
  })

  it('narrows strings with isDomainErrorCode', () => {
    expect(isDomainErrorCode('AN009')).toBe(true)
    expect(isDomainErrorCode('AN020')).toBe(true)
    expect(isDomainErrorCode('an009')).toBe(false)
    expect(isDomainErrorCode(1)).toBe(false)
  })
})

describe('domain error list', () => {
  it('numbers the codes without gaps, AN001 upwards', () => {
    const expected = DOMAIN_ERROR_CODES.map((_, index) => `AN${String(index + 1).padStart(3, '0')}`)
    expect(DOMAIN_ERROR_CODES).toEqual(expected)
  })

  it('never shows clients staff-security words (TOTP, MFA, 2FA) in an error text', () => {
    for (const locale of ['el', 'en'] as const) {
      for (const code of DOMAIN_ERROR_CODES) {
        const text = lookup(catalogue(locale), ['errors', code])
        expect(String(text), `${locale}: errors.${code}`).not.toMatch(/totp|mfa|2fa/i)
      }
    }
  })
})
