import { describe, expect, it } from 'vitest'
import {
  isAllowedProxyRoute,
  isUuid,
  PROXY_ALLOW_LIST,
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

  it('adds exactly the two booking functions and the short-code fallback (1.3)', () => {
    expect(isAllowedProxyRoute('POST', '/functions/v1/public-booking')).toBe(true)
    expect(isAllowedProxyRoute('POST', '/functions/v1/manage')).toBe(true)
    expect(isAllowedProxyRoute('POST', '/rest/v1/rpc/public_slug_for_code')).toBe(true)
    // Nothing changes on GET, and no other method or near-miss path gets through.
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      expect(isAllowedProxyRoute(method, '/functions/v1/public-booking')).toBe(false)
      expect(isAllowedProxyRoute(method, '/functions/v1/manage')).toBe(false)
    }
    expect(isAllowedProxyRoute('GET', '/rest/v1/rpc/public_slug_for_code')).toBe(false)
    expect(isAllowedProxyRoute('POST', '/functions/v1/manage/')).toBe(false)
    expect(isAllowedProxyRoute('POST', '/functions/v1/public-booking/start')).toBe(false)
  })

  it('never reaches the service-role RPCs of 0005 directly (only through the functions)', () => {
    const serviceRoleRpcs = [
      'otp_start',
      'otp_verify',
      'clients_for_phone',
      'book_appointment',
      'trusted_device_revoke',
      'manage_view',
      'manage_slots',
      'manage_cancel',
      'manage_reschedule',
      'claim_messages',
      'record_send_result',
    ]
    for (const rpc of serviceRoleRpcs) {
      for (const method of ['GET', 'POST']) {
        expect(isAllowedProxyRoute(method, `/rest/v1/rpc/${rpc}`), `${method} ${rpc}`).toBe(false)
      }
    }
    // Nor any table of 0005.
    for (const table of ['otp_challenges', 'trusted_devices', 'booking_tokens', 'messages_log']) {
      expect(isAllowedProxyRoute('GET', `/rest/v1/${table}`)).toBe(false)
      expect(isAllowedProxyRoute('POST', `/rest/v1/${table}`)).toBe(false)
    }
  })

  it('never reaches the dispatcher or its RPCs (1.5): only pg_net calls dispatch', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isAllowedProxyRoute(method, '/functions/v1/dispatch'), method).toBe(false)
    }
    for (const rpc of [
      'claim_due_messages',
      'record_delivery_report',
      'record_dispatch_run',
      'register_push_subscription',
      'unregister_push_subscription',
      'request_test_push',
    ]) {
      expect(isAllowedProxyRoute('POST', `/rest/v1/rpc/${rpc}`), rpc).toBe(false)
    }
    for (const table of ['push_subscriptions', 'member_notification_prefs']) {
      expect(isAllowedProxyRoute('GET', `/rest/v1/${table}`)).toBe(false)
    }
    expect(PROXY_ALLOW_LIST.some((route) => route.path.includes('dispatch'))).toBe(false)
  })

  it('lists every route once', () => {
    const keys = PROXY_ALLOW_LIST.map((route) => `${route.method} ${route.path}`)
    expect(new Set(keys).size).toBe(keys.length)
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
