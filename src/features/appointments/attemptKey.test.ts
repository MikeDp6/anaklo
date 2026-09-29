import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { newIdempotencyKey, nextAttempt, stableFingerprint, useAttemptKey } from './attemptKey'

function counter() {
  let n = 0
  return () => `key-${++n}`
}

describe('stableFingerprint', () => {
  it('ignores key order and undefined fields, keeps array order', () => {
    expect(stableFingerprint({ b: 1, a: [2, 1], c: undefined })).toBe(
      stableFingerprint({ a: [2, 1], b: 1 }),
    )
    expect(stableFingerprint({ a: [1, 2] })).not.toBe(stableFingerprint({ a: [2, 1] }))
    expect(stableFingerprint({ n: { y: 1, x: 2 } })).toBe('{"n":{"x":2,"y":1}}')
  })
})

describe('nextAttempt (one key per exact payload)', () => {
  it('keeps the key while the payload is the same and makes a new one when it changes', () => {
    const newKey = counter()
    const first = nextAttempt(null, 'payload-1', newKey)
    expect(first.key).toBe('key-1')
    expect(nextAttempt(first, 'payload-1', newKey)).toBe(first)
    const second = nextAttempt(first, 'payload-2', newKey)
    expect(second.key).toBe('key-2')
    expect(nextAttempt(second, 'payload-1', newKey).key).toBe('key-3')
  })
})

describe('useAttemptKey', () => {
  it('a retry of the same payload reuses the key; a changed time or flag gets a new one', () => {
    const newKey = counter()
    const { result } = renderHook(() => useAttemptKey(newKey))
    const payload = { startsAt: '2026-09-29T07:00:00Z', staffId: 's', allowOutsideHours: false }
    let keys: string[] = []
    act(() => {
      keys = [
        result.current(payload),
        result.current({ ...payload }), // e.g. «Δοκίμασε ξανά» after a timeout
        result.current({ ...payload, allowOutsideHours: true }), // D8 confirmed
        result.current({ ...payload, allowOutsideHours: true }),
        result.current({ ...payload, startsAt: '2026-09-29T08:00:00Z' }),
      ]
    })
    expect(keys).toEqual(['key-1', 'key-1', 'key-2', 'key-2', 'key-3'])
  })
})

describe('newIdempotencyKey', () => {
  it('is a v4 UUID', () => {
    expect(newIdempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
