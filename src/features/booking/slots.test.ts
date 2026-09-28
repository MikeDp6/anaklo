import { describe, expect, it } from 'vitest'
import { dateWindow, groupByDate, nearestSlots } from './slots'

describe('dateWindow', () => {
  it('shows 14 local days from today, capped by max_advance_days', () => {
    const first = dateWindow('2026-09-28', 0, 60)
    expect(first).toMatchObject({
      from: '2026-09-28',
      to: '2026-10-11',
      hasEarlier: false,
      hasLater: true,
    })
    expect(first.dates).toHaveLength(14)
    const last = dateWindow('2026-09-28', 4, 60)
    expect(last).toMatchObject({
      from: '2026-11-23',
      to: '2026-11-27',
      hasLater: false,
      hasEarlier: true,
    })
  })

  it('crosses DST and month ends by calendar days', () => {
    expect(dateWindow('2026-10-20', 0, 30).dates).toContain('2026-10-25')
    expect(dateWindow('2026-10-20', 0, 30).dates.at(-1)).toBe('2026-11-02')
  })

  it('with max_advance_days 0 offers today only', () => {
    expect(dateWindow('2026-09-28', 0, 0)).toMatchObject({ dates: ['2026-09-28'], hasLater: false })
  })
})

describe('groupByDate', () => {
  it('keeps the server order inside each day', () => {
    const groups = groupByDate([
      { local_date: '2026-10-01', id: 1 },
      { local_date: '2026-10-02', id: 2 },
      { local_date: '2026-10-01', id: 3 },
    ])
    expect(groups.get('2026-10-01')?.map((slot) => slot.id)).toEqual([1, 3])
    expect([...groups.keys()]).toEqual(['2026-10-01', '2026-10-02'])
  })
})

describe('nearestSlots (AN001 alternatives)', () => {
  const at = (time: string) => ({ starts_at: `2026-10-01T${time}:00+00:00` })

  it('offers the closest free starts in time order, never the taken one', () => {
    const slots = [at('06:00'), at('06:15'), at('06:30'), at('07:30'), at('05:45'), at('09:00')]
    const nearby = nearestSlots(slots, at('06:15').starts_at, 3)
    expect(nearby.map((slot) => slot.starts_at.slice(11, 16))).toEqual(['05:45', '06:00', '06:30'])
  })

  it('returns fewer when fewer are free', () => {
    expect(nearestSlots([at('06:00')], at('06:00').starts_at, 4)).toEqual([])
  })
})
