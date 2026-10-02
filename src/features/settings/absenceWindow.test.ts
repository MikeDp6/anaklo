import { describe, expect, it } from 'vitest'
import { absenceWindow } from './absenceWindow'

const ATHENS = 'Europe/Athens'

describe('absenceWindow (contract 1.6 §4.10)', () => {
  it('runs from now, floored to the minute, to the next local midnight', () => {
    // 2026-10-02 10:17:45.123 in Athens (UTC+3).
    expect(absenceWindow(new Date('2026-10-02T07:17:45.123Z'), ATHENS)).toEqual({
      from: '2026-10-02T07:17:00.000Z',
      to: '2026-10-02T21:00:00.000Z',
    })
  })

  it('an exact minute stays as it is', () => {
    expect(absenceWindow(new Date('2026-10-02T07:17:00.000Z'), ATHENS).from).toBe(
      '2026-10-02T07:17:00.000Z',
    )
  })

  it('on the 25-hour day (2026-10-25, back to UTC+2) it ends at that day’s local midnight', () => {
    // 00:10 local (still UTC+3) → midnight of the 26th at UTC+2.
    const { from, to } = absenceWindow(new Date('2026-10-24T21:10:00Z'), ATHENS)
    expect(from).toBe('2026-10-24T21:10:00.000Z')
    expect(to).toBe('2026-10-25T22:00:00.000Z')
    expect((Date.parse(to) - Date.parse(from)) / 3_600_000).toBeCloseTo(24 + 50 / 60)
  })

  it('on the 23-hour day (2026-03-29, forward to UTC+3) it ends at that day’s local midnight', () => {
    // 00:30 local (UTC+2) → midnight of the 30th at UTC+3.
    const { from, to } = absenceWindow(new Date('2026-03-28T22:30:00Z'), ATHENS)
    expect(to).toBe('2026-03-29T21:00:00.000Z')
    expect((Date.parse(to) - Date.parse(from)) / 3_600_000).toBeCloseTo(22.5)
  })

  it('late in the evening the window is short, never into the next day', () => {
    const { from, to } = absenceWindow(new Date('2026-10-02T20:59:30Z'), ATHENS)
    expect(from).toBe('2026-10-02T20:59:00.000Z')
    expect(to).toBe('2026-10-02T21:00:00.000Z')
  })

  it('follows the business zone, not the device', () => {
    expect(absenceWindow(new Date('2026-10-02T14:00:00Z'), 'America/New_York').to).toBe(
      '2026-10-03T04:00:00.000Z',
    )
  })
})
