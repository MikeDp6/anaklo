/**
 * CORS for the functions the pro app calls directly with the user's JWT (ADR-0008 §10):
 * `spike-push` now, `invite-member` and `manage-factors` in 1.7.
 * Functions behind the same-origin `/api` proxy never send CORS headers.
 *
 * `*` is safe here: these calls carry the user's JWT in `Authorization`, never cookies, so a
 * foreign page has nothing to borrow. Pure (ADR-0002 §3): Fetch API types only.
 */
export const JWT_FUNCTION_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // The headers supabase-js sends (cors.test.ts compares with `@supabase/supabase-js/cors`).
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
} as const

/** The answer to a CORS preflight (`OPTIONS`); the gateway lets it through without a JWT. */
export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: JWT_FUNCTION_CORS_HEADERS })
}

/** Adds the CORS headers to a response built by the helpers in `http.ts`. */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(JWT_FUNCTION_CORS_HEADERS)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
