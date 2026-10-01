// TEMPORARY: the push test C5 of ADR-0010 §3. Unused by the pro app since 1.5 (its test push goes
// through request_test_push and `dispatch`); kept only for the device test C5 and deleted in 1.10
// together with [functions.spike-push] in supabase/config.toml (contract 1.5 D17).
//
// Sends one test push through the OneSignal REST API to ONE subscription: the one named in the
// body, which the pro app reads from the SDK on the calling device (`{ subscription_id }`). It
// never addresses a user identity (no external_id, no aliases: ADR-0010 §2), so no member can
// receive someone else's pushes by claiming an identity in the browser. Until 1.5 there was no
// table to prove that the subscription is the caller's own; for a temporary, owners-only test
// with a fixed text that is acceptable (subscription ids are random and never shown to other
// users). Only owners may call it (role read from business_members under RLS, never from the
// JWT). verify_jwt = true: the pro app calls it directly with the user's JWT (ADR-0008 §10);
// the user is checked again here.
// Never logs keys, tokens, subscription ids or personal data.
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod/mini'
import { corsPreflight, withCors } from '../_shared/cors.ts'
import { errorResponse, json, parseJsonBody } from '../_shared/http.ts'
import {
  buildPushPayload,
  ONESIGNAL_NOTIFICATIONS_URL,
  pushClickUrl,
  SubscriptionIdBody,
} from '../_shared/onesignal.ts'
import { renderPushAllLocales } from '../_shared/push-templates.ts'

const ONESIGNAL_TIMEOUT_MS = 10_000
/** `{ subscription_id }` is all the body carries. */
const MAX_BODY_BYTES = 1024

const OwnerRows = z.array(z.object({ business_id: z.string() }))
/** OneSignal answers 200 with an empty `id` when the subscription is not subscribed. */
const OneSignalCreated = z.object({ id: z.optional(z.string()) })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflight()
  return withCors(await handle(req))
})

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('method_not_allowed', 'Method not allowed.', 405, {
      Allow: 'POST, OPTIONS',
    })
  }

  const authorization = req.headers.get('Authorization') ?? ''
  const jwt = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1]
  if (jwt === undefined) return errorResponse('unauthorized', 'Missing bearer token.', 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) {
    return errorResponse('not_configured', 'Supabase environment is missing.', 500)
  }

  // A client that acts as the caller: every query below runs under their RLS.
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: auth, error: authError } = await supabase.auth.getUser(jwt)
  if (authError !== null || auth.user === null) {
    return errorResponse('unauthorized', 'Invalid or expired session.', 401)
  }
  const userId = auth.user.id

  const body = await parseJsonBody(req, SubscriptionIdBody, MAX_BODY_BYTES)
  if (!body.ok) return body.response

  const { data: rows, error: rowsError } = await supabase
    .from('business_members')
    .select('business_id')
    .eq('user_id', userId)
    .eq('role', 'owner')
    .limit(1)
  const owners = OwnerRows.safeParse(rows)
  if (rowsError !== null || !owners.success) {
    console.error('spike-push: membership lookup failed', rowsError?.code ?? 'invalid rows')
    return errorResponse('membership_lookup_failed', 'Could not read the membership.', 500)
  }
  if (owners.data.length === 0) {
    return errorResponse('forbidden', 'Only an owner may send a test push.', 403)
  }

  const appId = Deno.env.get('ONESIGNAL_APP_ID')?.trim()
  const restApiKey = Deno.env.get('ONESIGNAL_REST_API_KEY')?.trim()
  if (!appId || !restApiKey) {
    return errorResponse('push_not_configured', 'OneSignal is not configured.', 503)
  }

  const payload = buildPushPayload({
    appId,
    subscriptionIds: [body.data.subscription_id],
    texts: renderPushAllLocales('push_test'),
    url: pushClickUrl(req.headers.get('Origin')),
  })

  let response: Response
  try {
    response = await fetch(ONESIGNAL_NOTIFICATIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Key ${restApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ONESIGNAL_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    console.error('spike-push: OneSignal request failed', timedOut ? 'timeout' : 'network')
    return timedOut
      ? errorResponse('push_timeout', 'OneSignal did not answer in time.', 504)
      : errorResponse('push_failed', 'OneSignal could not be reached.', 502)
  }

  if (!response.ok) {
    await response.body?.cancel()
    console.error('spike-push: OneSignal answered', response.status)
    return errorResponse('push_failed', `OneSignal answered ${response.status}.`, 502)
  }
  const created = OneSignalCreated.safeParse(await response.json().catch(() => null))
  if (!created.success || !created.data.id) {
    return errorResponse('not_subscribed', 'This subscription is not subscribed.', 409)
  }
  return json({ sent: true })
}
