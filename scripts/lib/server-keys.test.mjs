// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findServerKeys } from './server-keys.mjs'

// Synthetic values only, assembled here so that no key-shaped literal sits in the repository.
const ONESIGNAL_APP_KEY = ['os', 'v2', 'app', 'k7p2x9m4q8w3n6r5t1y0'.repeat(4)].join('_')
const ONESIGNAL_ORG_KEY = ['os', 'v2', 'org', 'z3c8v1b6n4m9l2k7j5h0'.repeat(4)].join('_')
const SUPABASE_SECRET = ['sb', 'secret', 'Xy7-Qw3_Er9TyUi0Op2As5Df'].join('_')

/** @param {Record<string, unknown>} payload */
function jwt(payload) {
  const part = (/** @type {unknown} */ value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.c2lnbmF0dXJl`
}

describe('findServerKeys', () => {
  it('finds the OneSignal REST API key of an app and an Organization API key', () => {
    expect(findServerKeys(ONESIGNAL_APP_KEY)).toEqual([
      'a OneSignal REST/Organization API key (os_v2_)',
    ])
    expect(findServerKeys(`const k="${ONESIGNAL_ORG_KEY}";`)).toEqual([
      'a OneSignal REST/Organization API key (os_v2_)',
    ])
  })

  it('finds Supabase secret keys and service_role JWTs inside bundled code', () => {
    expect(findServerKeys(`fetch(u,{headers:{apikey:"${SUPABASE_SECRET}"}})`)).toEqual([
      'a Supabase secret key (sb_secret_)',
    ])
    expect(findServerKeys(`x="${jwt({ role: 'service_role', iss: 'supabase' })}"`)).toEqual([
      'a service_role JWT',
    ])
  })

  it('reports every kind once, never the key itself', () => {
    const found = findServerKeys(
      [ONESIGNAL_APP_KEY, ONESIGNAL_APP_KEY, SUPABASE_SECRET, jwt({ role: 'service_role' })].join(
        '\n',
      ),
    )
    expect(found).toHaveLength(3)
    expect(found.join(' ')).not.toContain(ONESIGNAL_APP_KEY)
    expect(found.join(' ')).not.toContain(SUPABASE_SECRET)
  })

  it('lets the public values of the frontend through', () => {
    const publicValues = [
      // VITE_ONESIGNAL_APP_ID: the app id is public (ADR-0010 §2).
      '5f0e0d0c-0000-4000-8000-0000000000aa',
      'sb_publishable_dev_example',
      jwt({ role: 'anon', iss: 'supabase' }),
      'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js',
      // Prefixes alone, e.g. in an error message.
      'os_v2_app_',
      'sb_secret_',
    ]
    for (const value of publicValues) expect(findServerKeys(value)).toEqual([])
  })
})
