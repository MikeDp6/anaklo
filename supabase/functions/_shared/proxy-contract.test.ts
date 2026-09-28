import { describe, expect, it } from 'vitest'
import {
  isAllowedProxyRoute,
  isUuid,
  trustedDeviceCookieAttributes,
  trustedDeviceCookieName,
} from './proxy-contract.ts'

const BUSINESS = '00000000-0000-4000-8000-000000000001'

describe('trusted-device cookie', () => {
  it('uses __Host- and Secure everywhere except an explicit local environment', () => {
    for (const appEnv of ['dev', 'prod', '', undefined, 'LOCAL']) {
      expect(trustedDeviceCookieName(BUSINESS, appEnv)).toBe(`__Host-td_${BUSINESS}`)
      expect(trustedDeviceCookieAttributes(appEnv)).toContain('; Secure')
    }
  })

  it('drops the prefix and Secure only for APP_ENV=local', () => {
    expect(trustedDeviceCookieName(BUSINESS, 'local')).toBe(`td_${BUSINESS}`)
    expect(trustedDeviceCookieAttributes('local')).not.toContain('Secure')
  })

  it('is HttpOnly, SameSite=Lax, Path=/ and lasts 180 days', () => {
    expect(trustedDeviceCookieAttributes('prod')).toBe(
      'HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000; Secure',
    )
  })
})

describe('proxy allow-list', () => {
  it('matches exact method and path only', () => {
    expect(isAllowedProxyRoute('POST', '/rest/v1/rpc/public_business_profile')).toBe(true)
    expect(isAllowedProxyRoute('GET', '/rest/v1/rpc/public_business_profile')).toBe(false)
    expect(isAllowedProxyRoute('POST', '/rest/v1/clients')).toBe(false)
    expect(isAllowedProxyRoute('POST', '/rest/v1/rpc/public_business_profile/')).toBe(false)
  })

  it('lets the booking page reach the catalogue and slot RPCs (1.2) and nothing else of 0004', () => {
    expect(isAllowedProxyRoute('POST', '/rest/v1/rpc/public_booking_catalogue')).toBe(true)
    expect(isAllowedProxyRoute('POST', '/rest/v1/rpc/available_slots')).toBe(true)
    expect(isAllowedProxyRoute('GET', '/rest/v1/rpc/available_slots')).toBe(false)
    expect(isAllowedProxyRoute('POST', '/rest/v1/rpc/staff_available_slots')).toBe(false)
    expect(isAllowedProxyRoute('POST', '/rest/v1/rpc/staff_book_appointment')).toBe(false)
  })
})

describe('isUuid', () => {
  it('accepts UUIDs and rejects everything else', () => {
    expect(isUuid(BUSINESS)).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid(`${BUSINESS}; td_x=1`)).toBe(false)
    expect(isUuid(null)).toBe(false)
  })
})
