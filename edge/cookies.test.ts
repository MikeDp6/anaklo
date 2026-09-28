// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  parseCookieHeader,
  readCookie,
  readTrustedDeviceToken,
  trustedDeviceSetCookie,
} from './cookies.ts'

const BUSINESS = '00000000-0000-4000-8000-000000000001'

describe('parseCookieHeader', () => {
  it('reads name=value pairs, trims spaces and strips quotes', () => {
    const cookies = parseCookieHeader(' a=1;b = two ; c="q=v" ;empty=')
    expect([...cookies]).toEqual([
      ['a', '1'],
      ['b', 'two'],
      ['c', 'q=v'],
      ['empty', ''],
    ])
  })

  it('keeps the first of repeated names and skips malformed parts', () => {
    const cookies = parseCookieHeader('x=first; novalue; =anon; x=second')
    expect([...cookies]).toEqual([['x', 'first']])
  })

  it('returns an empty map without a header', () => {
    expect(parseCookieHeader(null).size).toBe(0)
    expect(parseCookieHeader('').size).toBe(0)
    expect(readCookie(undefined, 'x')).toBeNull()
  })
})

describe('readTrustedDeviceToken', () => {
  it('reads only the cookie of the given business and environment', () => {
    const header = `td_${BUSINESS}=local-token; __Host-td_${BUSINESS}=deployed-token`
    expect(readTrustedDeviceToken(header, BUSINESS, 'local')).toBe('local-token')
    expect(readTrustedDeviceToken(header, BUSINESS, 'dev')).toBe('deployed-token')
    expect(readTrustedDeviceToken(header, BUSINESS, undefined)).toBe('deployed-token')
    const other = '00000000-0000-4000-8000-000000000002'
    expect(readTrustedDeviceToken(header, other, 'dev')).toBeNull()
  })

  it('ignores a malformed token', () => {
    const header = `__Host-td_${BUSINESS}="bad token"`
    expect(readTrustedDeviceToken(header, BUSINESS, 'dev')).toBeNull()
  })
})

describe('trustedDeviceSetCookie', () => {
  it('writes __Host- and Secure outside local', () => {
    expect(trustedDeviceSetCookie(BUSINESS, 'abc_DEF-123', 'dev')).toBe(
      `__Host-td_${BUSINESS}=abc_DEF-123; HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000; Secure`,
    )
  })

  it('writes the plain name without Secure only for APP_ENV=local', () => {
    expect(trustedDeviceSetCookie(BUSINESS, 'abc', 'local')).toBe(
      `td_${BUSINESS}=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000`,
    )
  })

  it('deletes the cookie for an empty token', () => {
    expect(trustedDeviceSetCookie(BUSINESS, '', 'prod')).toBe(
      `__Host-td_${BUSINESS}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`,
    )
  })

  it('refuses tokens that could inject attributes', () => {
    expect(trustedDeviceSetCookie(BUSINESS, 'abc; Domain=evil.test', 'prod')).toBeNull()
    expect(trustedDeviceSetCookie(BUSINESS, 'a,b', 'prod')).toBeNull()
    expect(trustedDeviceSetCookie(BUSINESS, 'x'.repeat(1025), 'prod')).toBeNull()
  })
})
