import { expect, type Page } from '@playwright/test'
import { localSupabase } from '../../scripts/lib/cli.mjs'

/**
 * Straight calls to the LOCAL stack as the member signed in on a page (step 1.6 e2e: set-ups and
 * clean-ups the screens under test do not make, e.g. today's bookings of the absence flow, or
 * the time off a failed earlier run left behind). `localSupabase()` reads `supabase status` and
 * refuses any non-local API URL; the access token is the pro app's own session in the page, so
 * every call goes through RLS and the RPC role checks like the app's.
 */

let stack: ReturnType<typeof localSupabase> | undefined

async function accessToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!/^sb-.+-auth-token$/.test(key)) continue
      const session: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (typeof session === 'object' && session !== null && 'access_token' in session) {
        return typeof session.access_token === 'string' ? session.access_token : null
      }
    }
    return null
  })
  if (!token) throw new Error('no pro-app session in the page: sign in first')
  return token
}

/** `GET|POST|DELETE /rest/v1/<path>`; returns the status and the parsed body (null if none). */
export async function memberRest(
  page: Page,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<{ status: number; body: unknown }> {
  stack ??= localSupabase()
  const headers = {
    apikey: stack.publishableKey,
    authorization: `Bearer ${await accessToken(page)}`,
  }
  const response = await page.request.fetch(`${stack.apiUrl}/rest/v1/${path}`, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  })
  const text = await response.text()
  return { status: response.status(), body: text ? (JSON.parse(text) as unknown) : null }
}

/** An RPC as the member; fails the test unless it answers 200. */
export async function memberRpc(page: Page, name: string, args: unknown): Promise<unknown> {
  const { status, body } = await memberRest(page, 'POST', `rpc/${name}`, args)
  expect(status, JSON.stringify(body)).toBe(200)
  return body
}

/**
 * `POST /functions/v1/<name>` as the member (step 1.7: `invite-member`, `manage-factors` are
 * called by the app directly with the user's JWT, never through /api). Returns the status and the
 * parsed body (`{ code, message, hint }` on an error, contract 1.7 D12).
 */
export async function memberFunction(
  page: Page,
  name: string,
  data: unknown,
): Promise<{ status: number; body: unknown }> {
  stack ??= localSupabase()
  const response = await page.request.post(`${stack.apiUrl}/functions/v1/${name}`, {
    headers: {
      apikey: stack.publishableKey,
      authorization: `Bearer ${await accessToken(page)}`,
    },
    data,
  })
  const text = await response.text()
  return { status: response.status(), body: text ? (JSON.parse(text) as unknown) : null }
}
