import { readItem, removeItem, writeItem, type KeyValueStorage } from './storage'

/**
 * Session policy on the device (ADR-0009 §19). The Free dev project has no server-side
 * "inactivity timeout", so the app also ends a session after 30 days without use. No absolute
 * limit: an app opened every day stays signed in.
 */
export const SESSION_IDLE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000

const LAST_ACTIVITY_KEY = 'anaklo.pro.lastActivityAt'

/**
 * More than 30 days since the app was last opened or brought back. No timestamp (first run, or
 * storage the browser hides) is not stale: the caller records one right away.
 */
export function isSessionStale(lastActivityAt: Date | null, now: Date): boolean {
  if (lastActivityAt === null) return false
  return now.getTime() - lastActivityAt.getTime() > SESSION_IDLE_LIMIT_MS
}

export function readLastActivity(storage: KeyValueStorage | null): Date | null {
  const raw = readItem(storage, LAST_ACTIVITY_KEY)
  if (raw === null) return null
  const time = Number(raw)
  return Number.isFinite(time) ? new Date(time) : null
}

export function writeLastActivity(storage: KeyValueStorage | null, now: Date): void {
  writeItem(storage, LAST_ACTIVITY_KEY, String(now.getTime()))
}

export function clearLastActivity(storage: KeyValueStorage | null): void {
  removeItem(storage, LAST_ACTIVITY_KEY)
}

/**
 * On every open and return of the app: check first, then move the timestamp. A stale session
 * keeps its old timestamp, so the check repeats until the sign-out has gone through.
 */
export function recordActivity(storage: KeyValueStorage | null, now: Date): 'active' | 'stale' {
  if (isSessionStale(readLastActivity(storage), now)) return 'stale'
  writeLastActivity(storage, now)
  return 'active'
}
