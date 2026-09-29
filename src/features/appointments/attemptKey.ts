import { useCallback, useRef } from 'react'

/**
 * Idempotency keys of the pro app (contract 1.4 §2.6.6, §3.5): one key per ATTEMPT, i.e. per
 * exact payload. A retry after «Δεν αποθηκεύτηκε — χωρίς σύνδεση» resends the identical
 * variables with the same key (the server replays a booking or move that did go through); any
 * change of the payload (another time, a confirmed D8 flag, the SMS toggle) gets a new key.
 */

export interface Attempt {
  readonly fingerprint: string
  readonly key: string
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

/** JSON with sorted object keys: the same payload always gives the same text. */
export function stableFingerprint(payload: unknown): string {
  return JSON.stringify(canonical(payload)) ?? 'undefined'
}

/** Keeps the key while the fingerprint is unchanged; a new fingerprint gets a new key. Pure. */
export function nextAttempt(
  previous: Attempt | null,
  fingerprint: string,
  newKey: () => string,
): Attempt {
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: newKey() }
}

/** A v4 UUID; `getRandomValues` also works where `randomUUID` does not (older iOS). */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * `keyFor(payload)` (payload without the key) → the attempt key, called when the user submits.
 * Called from event handlers only, so the key never depends on how often the sheet renders.
 */
export function useAttemptKey(
  newKey: () => string = newIdempotencyKey,
): (payload: unknown) => string {
  const attempt = useRef<Attempt | null>(null)
  return useCallback(
    (payload: unknown) => {
      attempt.current = nextAttempt(attempt.current, stableFingerprint(payload), newKey)
      return attempt.current.key
    },
    [newKey],
  )
}
