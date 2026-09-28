/**
 * Reads a request body under a hard byte cap: for the `/api` proxy (`edge/api-proxy.ts`) and
 * the Edge Functions behind it (`parseJsonBody` in `http.ts`). Pure (ADR-0002 §3): Fetch and
 * Streams API only, the same in the Worker, Deno, Node and Vitest.
 *
 * `Content-Length` is only a shortcut. A chunked HTTP/1.1 or an HTTP/2 request may have none,
 * so the stream itself is counted and cancelled as soon as it passes the cap: at most
 * `maxBytes` plus one chunk is ever held in memory, whatever the client sends.
 */

export type BoundedBody =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | {
      ok: false
      /** `invalid_length`: a `Content-Length` that is not one decimal number. */
      reason: 'too_large' | 'invalid_length' | 'unreadable'
    }

const DECIMAL = /^\d+$/

export async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const value = declared.trim()
    // Never read as 0: a non-numeric (or repeated, "10, 10") length is refused, not trusted.
    if (!DECIMAL.test(value)) return { ok: false, reason: 'invalid_length' }
    if (Number(value) > maxBytes) return { ok: false, reason: 'too_large' }
  }

  const body = request.body
  if (body === null) return { ok: true, bytes: new Uint8Array(0) }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) {
        // Stop the upload here; the caller answers 413 without waiting for the rest.
        reader.cancel().catch(() => undefined)
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(chunk.value)
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}
