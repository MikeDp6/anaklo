import type { APIRequestContext, BrowserContext } from '@playwright/test'

/**
 * Online bookings of the e2e are cancelled when their test ends (the auto fixture of
 * ./fixtures.ts), through their manage link, as a client would. Without it every run leaves its
 * bookings behind: the first bookable days fill up, `chooseDay` (which counts days WITH free
 * times) shifts to another day, and two parallel tests end up on one day and one time («Η ώρα …
 * μόλις κλείστηκε»). A cancelled appointment blocks nothing, so reruns find the same free times.
 *
 * Nothing is deleted (no API role may); `npm run db:reset` clears the cancelled rows.
 */

const PUBLIC_BOOKING_PATH = '/api/functions/v1/public-booking'
const MANAGE_PATH = '/api/functions/v1/manage'
/** manage_token_invalid: the test already cancelled it (a cancel revokes every link). */
const ALREADY_REVOKED = 'AN015'

/** Tokens of bookings made outside a page (bookViaApi) in this worker's current test. */
const apiTokens = new Set<string>()

export function rememberManageToken(token: string): void {
  apiTokens.add(token)
}

/**
 * Collects the manage token of every successful `book` answer the context's pages receive.
 * Returns a function that waits for the pending body reads and hands out the tokens.
 */
export function collectBookings(context: BrowserContext): () => Promise<string[]> {
  const tokens = new Set<string>()
  const reads: Promise<void>[] = []
  context.on('response', (response) => {
    if (
      response.request().method() !== 'POST' ||
      new URL(response.url()).pathname !== PUBLIC_BOOKING_PATH ||
      !response.ok()
    ) {
      return
    }
    reads.push(
      response.json().then(
        (body: unknown) => {
          if (typeof body === 'object' && body !== null && 'manage_token' in body) {
            const token = body.manage_token
            if (typeof token === 'string') tokens.add(token)
          }
        },
        // The page navigated before the body could be read: the booking stays (db:reset).
        () => undefined,
      ),
    )
  })
  return async () => {
    await Promise.all(reads)
    return [...tokens]
  }
}

/** Cancels each booking once; a link the test itself already used to cancel is fine. */
export async function cancelBookings(
  request: APIRequestContext,
  pageTokens: readonly string[],
): Promise<void> {
  const tokens = new Set([...pageTokens, ...apiTokens])
  apiTokens.clear()
  for (const token of tokens) {
    const response = await request.post(MANAGE_PATH, { data: { action: 'cancel', token } })
    if (response.ok()) continue
    const text = await response.text()
    if (text.includes(ALREADY_REVOKED)) continue
    throw new Error(`cleanup: cancelling a test booking failed (${response.status()}): ${text}`)
  }
}
