// Server-side keys that must never reach the frontend (ADR-0005, CLAUDE.md > Εντολές). Shared by
// vite.config.ts (refuses VITE_* values before the build) and scripts/check-secrets.mjs (scans
// dist after it). Pure. Vitest: server-keys.test.mjs.

/** Supabase secret API keys. */
const SUPABASE_SECRET_KEY = /sb_secret_[\w-]{8,}/

/**
 * OneSignal REST API keys (`os_v2_app_…`, per app) and Organization API keys (`os_v2_org_…`):
 * either one sends pushes to every subscription of the app (ADR-0010 §2).
 */
const ONESIGNAL_API_KEY = /os_v2_(?:app|org)_[a-z0-9]{8,}/i

/** A JWT; group 1 is its payload. */
const JWT = /eyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]+/g

/**
 * The kinds of server key found in `text`, one entry per kind, in a fixed order. Never the key
 * itself, so a report can be printed.
 * @param {string} text
 * @returns {string[]}
 */
export function findServerKeys(text) {
  /** @type {string[]} */
  const found = []
  if (SUPABASE_SECRET_KEY.test(text)) found.push('a Supabase secret key (sb_secret_)')
  if (ONESIGNAL_API_KEY.test(text)) found.push('a OneSignal REST/Organization API key (os_v2_)')
  for (const match of text.matchAll(JWT)) {
    if (isServiceRoleJwtPayload(match[1])) {
      found.push('a service_role JWT')
      break
    }
  }
  return found
}

/** @param {string | undefined} segment */
function isServiceRoleJwtPayload(segment) {
  if (!segment) return false
  try {
    /** @type {unknown} */
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return typeof payload === 'object' && payload !== null && 'role' in payload
      ? payload.role === 'service_role'
      : false
  } catch {
    return false // not a JWT payload
  }
}
