import { z } from 'zod/mini'
import { readItem, removeItem, writeItem, type KeyValueStorage } from './storage'

/**
 * The email of a sign-in in progress (ADR-0009 §5). iOS may close the installed app while the
 * user reads the code in Mail; when it reopens, the login screen goes straight back to the code
 * step. Saved before the code is requested, cleared on success or expiry. The code itself is
 * never stored.
 */
const PENDING_EMAIL_KEY = 'anaklo.pro.pendingLoginEmail'

/** Same lifetime as the email code (`otp_expiry = 600`, ADR-0009 §1). */
export const PENDING_EMAIL_TTL_MS = 10 * 60 * 1000

const StoredPendingEmail = z.object({ email: z.string(), expiresAt: z.number() })

export interface PendingSignIn {
  readonly email: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

export function savePendingEmail(storage: KeyValueStorage | null, email: string, now: Date): void {
  restorePendingSignIn(storage, { email, expiresAt: now.getTime() + PENDING_EMAIL_TTL_MS })
}

/**
 * Puts an entry back exactly as it was, expiry included: a resend that failed must neither end
 * nor extend a sign-in whose earlier code is still valid.
 */
export function restorePendingSignIn(storage: KeyValueStorage | null, entry: PendingSignIn): void {
  const value = { email: entry.email, expiresAt: entry.expiresAt }
  writeItem(storage, PENDING_EMAIL_KEY, JSON.stringify(value))
}

/** The pending sign-in, or null. An expired or unreadable entry is removed on the way. */
export function readPendingSignIn(
  storage: KeyValueStorage | null,
  now: Date,
): PendingSignIn | null {
  const raw = readItem(storage, PENDING_EMAIL_KEY)
  if (raw === null) return null
  const parsed = StoredPendingEmail.safeParse(parseJson(raw))
  if (!parsed.success || parsed.data.expiresAt <= now.getTime()) {
    clearPendingEmail(storage)
    return null
  }
  return parsed.data
}

/** The pending email, or null. An expired or unreadable entry is removed on the way. */
export function readPendingEmail(storage: KeyValueStorage | null, now: Date): string | null {
  return readPendingSignIn(storage, now)?.email ?? null
}

export function clearPendingEmail(storage: KeyValueStorage | null): void {
  removeItem(storage, PENDING_EMAIL_KEY)
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
