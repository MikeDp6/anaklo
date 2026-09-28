/**
 * The contract between the `/api` proxy (the Cloudflare Worker and the Vite dev middleware,
 * ADR-0008) and the Edge Functions behind it. Pure constants and helpers: no Deno, DOM or Node
 * APIs (ADR-0002 §3), so the Worker, Vite and the functions all import this one file.
 */

export const PROXY_HEADERS = {
  /** Shared secret added by the proxy; functions behind `/api` refuse requests without it. */
  secret: 'x-anaklo-proxy-secret',
  /** The client's real IP, taken by the proxy from `CF-Connecting-IP` (never from the client). */
  clientIp: 'x-anaklo-client-ip',
  /** The business the booking page talks about; the only client `x-anaklo-*` header read. */
  business: 'x-anaklo-business',
  /** Request: the trusted-device token of that business, read by the proxy from its cookie. */
  trustedDevice: 'x-anaklo-td',
  /** Response: a new trusted-device token; the proxy turns it into the cookie and strips it. */
  setTrustedDevice: 'x-anaklo-set-td',
} as const

/** 180 days (ADR-0006). */
export const TRUSTED_DEVICE_MAX_AGE_SECONDS = 15_552_000

/**
 * Only an explicit `local` relaxes the cookie (plain http on localhost, where WebKit drops
 * `Secure` cookies). Any other value, or none, is treated as a deployed environment.
 */
export function isLocalAppEnv(appEnv: string | undefined): boolean {
  return appEnv === 'local'
}

export function trustedDeviceCookieName(businessId: string, appEnv: string | undefined): string {
  return isLocalAppEnv(appEnv) ? `td_${businessId}` : `__Host-td_${businessId}`
}

export function trustedDeviceCookieAttributes(appEnv: string | undefined): string {
  const base = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${TRUSTED_DEVICE_MAX_AGE_SECONDS}`
  return isLocalAppEnv(appEnv) ? base : `${base}; Secure`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export type ProxyRoute = { readonly method: 'GET' | 'POST'; readonly path: string }

/**
 * The only upstream paths (after the `/api` prefix) the proxy forwards; anything else is 404.
 * Exact matches, method included. The list grows step by step (1.2 catalogue and slots,
 * 1.3 `public-booking` and `manage`); every addition is deliberate and tested.
 */
export const PROXY_ALLOW_LIST: readonly ProxyRoute[] = [
  { method: 'POST', path: '/rest/v1/rpc/public_business_profile' },
  { method: 'GET', path: '/functions/v1/health' },
  { method: 'POST', path: '/functions/v1/spike-td' },
]

export function isAllowedProxyRoute(method: string, path: string): boolean {
  return PROXY_ALLOW_LIST.some((route) => route.method === method && route.path === path)
}
