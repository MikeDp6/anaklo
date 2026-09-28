import { isManageToken, isShortCode } from '../../../supabase/functions/_shared/booking-schemas.ts'

/**
 * The booking entry resolves the path itself instead of shipping React Router (~30 KB gzip) on
 * the page with the tightest budget (ADR-0001/0002). Booking steps live in component state; the
 * URL stays `/<slug>`. Relative import (not `@fn-shared`): the Worker type-checks this file too.
 */
export type BookingRoute =
  | { kind: 'landing' }
  | { kind: 'business'; slug: string }
  /** `/m/<token>`: the manage link of one appointment (22 base64url characters). */
  | { kind: 'manage'; token: string }
  /** `/r/<code>`: the short link of the SMS; the Worker redirects, the page is the fallback. */
  | { kind: 'short-link'; code: string }
  | { kind: 'not-found' }

const SLUG_PATH = /^\/([a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9]))\/?$/i
const MANAGE_PATH = /^\/m\/([^/]+)\/?$/
const SHORT_LINK_PATH = /^\/r\/([^/]+)\/?$/i

export function resolveBookingRoute(pathname: string): BookingRoute {
  if (pathname === '/' || pathname === '') return { kind: 'landing' }
  const manage = MANAGE_PATH.exec(pathname)?.[1]
  if (manage !== undefined)
    return isManageToken(manage) ? { kind: 'manage', token: manage } : { kind: 'not-found' }
  const code = SHORT_LINK_PATH.exec(pathname)?.[1]?.toLowerCase()
  if (code !== undefined)
    return isShortCode(code) ? { kind: 'short-link', code } : { kind: 'not-found' }
  const match = SLUG_PATH.exec(pathname)
  if (match?.[1]) return { kind: 'business', slug: match[1].toLowerCase() }
  return { kind: 'not-found' }
}

/** TEMPORARY (until the 1.10 device tests): `?spike=td` shows the trusted-device test panel. */
export function isTrustedDeviceSpike(search: string): boolean {
  return new URLSearchParams(search).get('spike') === 'td'
}
