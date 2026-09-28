import { describe, expect, it } from 'vitest'
import {
  clearPendingEmail,
  PENDING_EMAIL_TTL_MS,
  readPendingEmail,
  readPendingSignIn,
  restorePendingSignIn,
  savePendingEmail,
} from './pendingEmail'
import { memoryStorage } from './storage'

const now = new Date('2026-10-15T09:00:00Z')
const later = (ms: number) => new Date(now.getTime() + ms)
const KEY = 'anaklo.pro.pendingLoginEmail'

describe('pending sign-in email (ADR-0009 §5)', () => {
  it('is read back within 10 minutes', () => {
    const storage = memoryStorage()
    savePendingEmail(storage, 'owner@demo-barber.test', now)
    expect(readPendingEmail(storage, later(9 * 60_000))).toBe('owner@demo-barber.test')
  })

  it('expires after 10 minutes and is removed', () => {
    const storage = memoryStorage()
    savePendingEmail(storage, 'owner@demo-barber.test', now)
    expect(readPendingEmail(storage, later(PENDING_EMAIL_TTL_MS))).toBeNull()
    expect(storage.getItem(KEY)).toBeNull()
  })

  it('stores only the email and its expiry, never a code', () => {
    const storage = memoryStorage()
    savePendingEmail(storage, 'owner@demo-barber.test', now)
    expect(JSON.parse(storage.getItem(KEY) ?? 'null')).toEqual({
      email: 'owner@demo-barber.test',
      expiresAt: now.getTime() + PENDING_EMAIL_TTL_MS,
    })
  })

  it('is cleared on demand (success, other email)', () => {
    const storage = memoryStorage()
    savePendingEmail(storage, 'owner@demo-barber.test', now)
    clearPendingEmail(storage)
    expect(readPendingEmail(storage, now)).toBeNull()
  })

  it('a malformed entry is ignored and removed', () => {
    const storage = memoryStorage()
    storage.setItem(KEY, '{not json')
    expect(readPendingEmail(storage, now)).toBeNull()
    expect(storage.getItem(KEY)).toBeNull()
    storage.setItem(KEY, JSON.stringify({ email: 42 }))
    expect(readPendingEmail(storage, now)).toBeNull()
  })

  it('without storage nothing is kept and nothing throws', () => {
    savePendingEmail(null, 'owner@demo-barber.test', now)
    expect(readPendingEmail(null, now)).toBeNull()
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => savePendingEmail(throwing, 'a@b.test', now)).not.toThrow()
    expect(readPendingEmail(throwing, now)).toBeNull()
  })

  it('is put back with its original expiry, not a new one', () => {
    const storage = memoryStorage()
    savePendingEmail(storage, 'owner@demo-barber.test', now)
    const entry = readPendingSignIn(storage, later(60_000))
    expect(entry).toEqual({
      email: 'owner@demo-barber.test',
      expiresAt: now.getTime() + PENDING_EMAIL_TTL_MS,
    })
    savePendingEmail(storage, 'owner@demo-barber.test', later(60_000))
    if (entry) restorePendingSignIn(storage, entry)
    expect(readPendingEmail(storage, later(PENDING_EMAIL_TTL_MS - 1))).toBe(
      'owner@demo-barber.test',
    )
    expect(readPendingEmail(storage, later(PENDING_EMAIL_TTL_MS))).toBeNull()
  })
})
