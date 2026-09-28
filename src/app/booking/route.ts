/**
 * The booking entry has exactly three outcomes, so it resolves the path itself instead of
 * shipping React Router (~30 KB gzip) on the page with the tightest budget (ADR-0001/0002).
 * Booking steps live in component state; the URL stays `/<slug>`.
 */
export type BookingRoute =
  { kind: 'landing' } | { kind: 'business'; slug: string } | { kind: 'not-found' }

const SLUG_PATH = /^\/([a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9]))\/?$/i

export function resolveBookingRoute(pathname: string): BookingRoute {
  if (pathname === '/' || pathname === '') return { kind: 'landing' }
  const match = SLUG_PATH.exec(pathname)
  if (match?.[1]) return { kind: 'business', slug: match[1].toLowerCase() }
  return { kind: 'not-found' }
}

/** TEMPORARY (step 1.1): `?spike=td` shows the trusted-device test panel on a business page. */
export function isTrustedDeviceSpike(search: string): boolean {
  return new URLSearchParams(search).get('spike') === 'td'
}
