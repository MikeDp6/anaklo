import { beforeAll, describe, expect, it } from 'vitest'
import i18next from 'i18next'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { durationParts } from './durationParts'

describe('durationParts (contract 1.6 §4.8)', () => {
  it('splits minutes into days, hours and minutes, leaving zero units out', () => {
    expect(durationParts(0)).toEqual([])
    expect(durationParts(15)).toEqual([{ unit: 'minutes', count: 15 }])
    expect(durationParts(60)).toEqual([{ unit: 'hours', count: 1 }])
    expect(durationParts(90)).toEqual([
      { unit: 'hours', count: 1 },
      { unit: 'minutes', count: 30 },
    ])
    expect(durationParts(720)).toEqual([{ unit: 'hours', count: 12 }])
    expect(durationParts(1440)).toEqual([{ unit: 'days', count: 1 }])
    expect(durationParts(10080)).toEqual([{ unit: 'days', count: 7 }])
    expect(durationParts(1500)).toEqual([
      { unit: 'days', count: 1 },
      { unit: 'hours', count: 1 },
    ])
  })
})

describe('the labels (pro i18n plurals)', () => {
  beforeAll(async () => {
    await initI18n(proCatalogues)
  })

  const label = (minutes: number) => {
    const parts = durationParts(minutes)
    if (parts.length === 0) return i18next.t('pro:policy.duration.none')
    return parts
      .map((part) => i18next.t(`pro:policy.duration.${part.unit}`, { count: part.count }))
      .join(' ')
  }

  it('reads «Καμία», «15 λεπτά», «2 ώρες», «1 μέρα», «1 ώρα 30 λεπτά»', () => {
    expect(label(0)).toBe('Καμία')
    expect(label(15)).toBe('15 λεπτά')
    expect(label(120)).toBe('2 ώρες')
    expect(label(1440)).toBe('1 μέρα')
    expect(label(90)).toBe('1 ώρα 30 λεπτά')
  })
})
