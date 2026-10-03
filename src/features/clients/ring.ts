/**
 * E18 rhythm ring (contract 1.8 §4.4, MOTION.md E18): the geometry of the SVG only. What the
 * ring shows (days since the last visit against the shop's interval) is computed by the server
 * (`client_card`, rule 13); this turns its `fraction` into a stroke offset.
 */

export const RING_SIZE = 96
export const RING_RADIUS = 42
export const RING_STROKE = 8

export interface RingGeometry {
  /** The full stroke length (2πr): the dash array, and the offset of an empty ring. */
  readonly circumference: number
  /** The final offset: circumference × (1 − fraction), the fraction clamped to [0, 1]. */
  readonly offset: number
}

export function ringGeometry(fraction: number | null, radius: number = RING_RADIUS): RingGeometry {
  const circumference = 2 * Math.PI * radius
  const value = fraction ?? 0
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  return { circumference, offset: circumference * (1 - clamped) }
}
