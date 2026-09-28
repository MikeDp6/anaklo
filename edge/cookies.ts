import {
  TRUSTED_DEVICE_MAX_AGE_SECONDS,
  trustedDeviceCookieAttributes,
  trustedDeviceCookieName,
} from '../supabase/functions/_shared/proxy-contract.ts'

/**
 * Cookie helpers for the Worker and the Vite dev middleware (ADR-0008 §4). The cookie name and
 * attributes come only from the proxy contract; this module parses and formats.
 */

/**
 * The tokens the proxy accepts in either direction: RFC 6265 cookie-octets minus the characters
 * that would need quoting. Anything else is never forwarded as a header or written as a cookie.
 */
const COOKIE_TOKEN = /^[\w.~+/=-]{1,1024}$/

export function isCookieToken(value: string): boolean {
  return COOKIE_TOKEN.test(value)
}

/**
 * Parses a `Cookie` request header. Values are kept raw (no URL decoding); when a name repeats,
 * the first occurrence wins, as browsers send the most specific cookie first.
 */
export function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  if (!header) return cookies
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    let value = part.slice(separator + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    if (name && !cookies.has(name)) cookies.set(name, value)
  }
  return cookies
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  return parseCookieHeader(header).get(name) ?? null
}

/** The trusted-device token of one business from the request cookies, if well-formed. */
export function readTrustedDeviceToken(
  cookieHeader: string | null | undefined,
  businessId: string,
  appEnv: string | undefined,
): string | null {
  const token = readCookie(cookieHeader, trustedDeviceCookieName(businessId, appEnv))
  return token !== null && isCookieToken(token) ? token : null
}

/**
 * The `Set-Cookie` value for a token returned by an Edge Function (`x-anaklo-set-td`).
 * An empty token deletes the cookie (`Max-Age=0`); a malformed one yields `null` (nothing set).
 */
export function trustedDeviceSetCookie(
  businessId: string,
  token: string,
  appEnv: string | undefined,
): string | null {
  const name = trustedDeviceCookieName(businessId, appEnv)
  const attributes = trustedDeviceCookieAttributes(appEnv)
  if (token === '') {
    return `${name}=; ${attributes.replace(`Max-Age=${TRUSTED_DEVICE_MAX_AGE_SECONDS}`, 'Max-Age=0')}`
  }
  return isCookieToken(token) ? `${name}=${token}; ${attributes}` : null
}
