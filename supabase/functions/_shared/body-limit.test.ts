// @vitest-environment node
// Request and ReadableStream from Node (undici), the same Fetch/Streams API as Deno and Workers.
import { describe, expect, it } from 'vitest'
import { readBoundedBody } from './body-limit.ts'

const ENDPOINT = 'http://localhost/functions/v1/health'
const LIMIT = 1024
const CHUNK = 256

function streamRequest(stream: ReadableStream<Uint8Array>): Request {
  // `duplex` is required by the Fetch spec for stream bodies; not yet in the DOM typings.
  return new Request(ENDPOINT, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
}

/**
 * A request body that is a stream without Content-Length (as with chunked HTTP/1.1 or HTTP/2),
 * `total` bytes in chunks of CHUNK. It counts what was pulled (no read-ahead) and whether it was
 * cancelled.
 */
function streamed(total: number) {
  const state = { pulled: 0, cancelled: false }
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= total) {
          controller.close()
          return
        }
        const size = Math.min(CHUNK, total - state.pulled)
        state.pulled += size
        controller.enqueue(new Uint8Array(size).fill(0x61))
      },
      cancel() {
        state.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { request: streamRequest(stream), state }
}

describe('readBoundedBody', () => {
  it('returns the whole body when it fits', async () => {
    const request = new Request(ENDPOINT, { method: 'POST', body: '{"a":1}' })
    const result = await readBoundedBody(request, LIMIT)
    expect(result.ok && new TextDecoder().decode(result.bytes)).toBe('{"a":1}')
  })

  it('returns an empty body when there is none', async () => {
    const result = await readBoundedBody(new Request(ENDPOINT), LIMIT)
    expect(result).toEqual({ ok: true, bytes: new Uint8Array(0) })
  })

  it('accepts a streamed body of exactly the limit', async () => {
    const { request } = streamed(LIMIT)
    const result = await readBoundedBody(request, LIMIT)
    expect(result.ok && result.bytes.byteLength).toBe(LIMIT)
  })

  it('refuses a declared Content-Length over the limit without reading', async () => {
    const { request, state } = streamed(LIMIT * 4)
    request.headers.set('content-length', String(LIMIT * 4))
    await expect(readBoundedBody(request, LIMIT)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(state.pulled).toBe(0)
  })

  it('stops a stream without Content-Length as soon as it passes the limit', async () => {
    // 1 GB: arrayBuffer() would hold all of it before any size check.
    const { request, state } = streamed(1024 * 1024 * 1024)
    expect(request.headers.get('content-length')).toBeNull()
    await expect(readBoundedBody(request, LIMIT)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    })
    // The limit plus the one chunk that crossed it, then the upload is cancelled.
    expect(state.pulled).toBe(LIMIT + CHUNK)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.cancelled).toBe(true)
  })

  it.each(['abc', '-1', '1e3', '10, 10', ''])(
    'refuses a Content-Length that is not a decimal number (%j), never reads it as 0',
    async (value) => {
      const request = new Request(ENDPOINT, { method: 'POST', body: 'x' })
      request.headers.set('content-length', value)
      await expect(readBoundedBody(request, LIMIT)).resolves.toEqual({
        ok: false,
        reason: 'invalid_length',
      })
    },
  )

  it('reports a body stream that fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'))
      },
    })
    await expect(readBoundedBody(streamRequest(stream), LIMIT)).resolves.toEqual({
      ok: false,
      reason: 'unreadable',
    })
  })
})
