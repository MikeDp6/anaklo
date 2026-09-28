import { describe, expect, it } from 'vitest'
import {
  clearLastActivity,
  isSessionStale,
  readLastActivity,
  recordActivity,
  SESSION_IDLE_LIMIT_MS,
  writeLastActivity,
} from './sessionPolicy'
import { memoryStorage } from './storage'

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-10-15T09:00:00Z')
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY)

describe('isSessionStale (30 days of inactivity, ADR-0009 §19)', () => {
  it('29 days since the last use: still signed in', () => {
    expect(isSessionStale(daysAgo(29), now)).toBe(false)
  })

  it('31 days since the last use: stale', () => {
    expect(isSessionStale(daysAgo(31), now)).toBe(true)
  })

  it('exactly 30 days is not yet more than 30 days', () => {
    expect(isSessionStale(new Date(now.getTime() - SESSION_IDLE_LIMIT_MS), now)).toBe(false)
    expect(isSessionStale(new Date(now.getTime() - SESSION_IDLE_LIMIT_MS - 1), now)).toBe(true)
  })

  it('no timestamp yet is not stale', () => {
    expect(isSessionStale(null, now)).toBe(false)
  })

  it('a timestamp in the future (clock changed) is not stale', () => {
    expect(isSessionStale(new Date(now.getTime() + DAY), now)).toBe(false)
  })
})

describe('recordActivity: check first, then move the timestamp', () => {
  it('an active session gets the new timestamp', () => {
    const storage = memoryStorage()
    writeLastActivity(storage, daysAgo(29))
    expect(recordActivity(storage, now)).toBe('active')
    expect(readLastActivity(storage)).toEqual(now)
  })

  it('a stale session keeps its old timestamp, so the check repeats until sign-out', () => {
    const storage = memoryStorage()
    writeLastActivity(storage, daysAgo(31))
    expect(recordActivity(storage, now)).toBe('stale')
    expect(readLastActivity(storage)).toEqual(daysAgo(31))
    expect(recordActivity(storage, now)).toBe('stale')
  })

  it('the first open records a timestamp', () => {
    const storage = memoryStorage()
    expect(recordActivity(storage, now)).toBe('active')
    expect(readLastActivity(storage)).toEqual(now)
  })

  it('works without storage (blocked by the browser)', () => {
    expect(recordActivity(null, now)).toBe('active')
    expect(readLastActivity(null)).toBeNull()
  })

  it('an unreadable value counts as no timestamp; clear removes it', () => {
    const storage = memoryStorage()
    storage.setItem('anaklo.pro.lastActivityAt', 'garbage')
    expect(readLastActivity(storage)).toBeNull()
    writeLastActivity(storage, now)
    clearLastActivity(storage)
    expect(readLastActivity(storage)).toBeNull()
  })
})
