import { describe, expect, it } from 'vitest'
import { ringGeometry, RING_RADIUS } from './ring'

const C = 2 * Math.PI * RING_RADIUS

describe('ringGeometry (E18, contract 1.8 §4.4)', () => {
  it('the dash array is the full circle; the offset leaves (1 − fraction) of it undrawn', () => {
    expect(ringGeometry(0)).toEqual({ circumference: C, offset: C })
    expect(ringGeometry(1)).toEqual({ circumference: C, offset: 0 })
    expect(ringGeometry(0.36).offset).toBeCloseTo(C * 0.64, 10)
  })

  it('no fraction (no interval) is an empty ring', () => {
    expect(ringGeometry(null).offset).toBe(C)
  })

  it('clamps what the server would never send', () => {
    expect(ringGeometry(-0.2).offset).toBe(C)
    expect(ringGeometry(1.7).offset).toBe(0)
    expect(ringGeometry(Number.NaN).offset).toBe(C)
  })
})
