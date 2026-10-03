import { describe, expect, it } from 'vitest'
import { clockAtLeast } from './useNow'

describe('clockAtLeast', () => {
  const tick = new Date('2026-10-03T15:30:20Z')

  it('moves to the fetch time when the list was fetched after the last tick', () => {
    // A walk-in started at 15:31:00.7 and the list refetched right after: it is «Τώρα».
    const fetchedAt = Date.parse('2026-10-03T15:31:01Z')
    expect(clockAtLeast(tick, fetchedAt).toISOString()).toBe('2026-10-03T15:31:01.000Z')
  })

  it('keeps the ticking clock when it is later than the fetch', () => {
    expect(clockAtLeast(tick, Date.parse('2026-10-03T15:29:00Z'))).toBe(tick)
  })

  it('keeps the ticking clock before the first fetch (dataUpdatedAt 0)', () => {
    expect(clockAtLeast(tick, 0)).toBe(tick)
  })
})
