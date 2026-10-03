import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { ringGeometry } from '../ring'
import type { ClientRing } from '../schema'
import { RhythmRing } from './RhythmRing'

const WITHIN: ClientRing = {
  state: 'within',
  daysSinceLast: 10,
  intervalDays: 28,
  intervalWeeks: 4,
  fraction: 0.36,
  overdueDays: null,
  hintKey: 'nextVisit.vertical',
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

afterEach(() => {
  cleanup()
})

function progress(container: HTMLElement) {
  return container.querySelector<SVGCircleElement>('circle.ring-progress')
}

describe('RhythmRing (E18, contract 1.8 §4.4)', () => {
  it('draws the server’s fraction: the circle ends at --ring-to = the geometry’s offset', () => {
    const { container } = render(<RhythmRing ring={WITHIN} />)
    const circle = progress(container)
    const { circumference, offset } = ringGeometry(0.36)
    expect(circle).not.toBeNull()
    expect(circle?.style.getPropertyValue('--circ')).toBe(String(circumference))
    expect(circle?.style.getPropertyValue('--ring-to')).toBe(String(offset))
  })

  it('is one image named from i18n: days, the state sentence and its basis', () => {
    render(<RhythmRing ring={WITHIN} />)
    expect(
      screen.getByRole('img', {
        name: 'Ρυθμός επισκέψεων. 10 μέρες από την τελευταία επίσκεψη. Μέσα στο συνηθισμένο διάστημα (περίπου 4 εβδομάδες). με βάση τον κλάδο',
      }),
    ).toBeInTheDocument()
  })

  it('beyond the interval: a full circle in the attention colour, the overdue days in the name', () => {
    const { container } = render(
      <RhythmRing
        ring={{ ...WITHIN, state: 'beyond', daysSinceLast: 40, fraction: 1, overdueDays: 12 }}
      />,
    )
    expect(progress(container)?.style.getPropertyValue('--ring-to')).toBe('0')
    const ring = screen.getByRole('img')
    expect(ring).toHaveAttribute('data-state', 'beyond')
    expect(ring).toHaveAccessibleName(/Πέρασε το συνηθισμένο διάστημα κατά 12 μέρες\./)
  })

  it('no interval to compare with: no progress circle at all', () => {
    const { container } = render(
      <RhythmRing
        ring={{
          ...WITHIN,
          state: 'no_interval',
          fraction: null,
          intervalDays: null,
          intervalWeeks: null,
          hintKey: null,
        }}
      />,
    )
    expect(progress(container)).toBeNull()
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Ρυθμός επισκέψεων. 10 μέρες από την τελευταία επίσκεψη. Δεν υπάρχει ακόμη διάστημα για σύγκριση.',
    )
  })

  it('no completed visit: an empty ring with «—» in the centre', () => {
    const { container } = render(
      <RhythmRing ring={{ ...WITHIN, state: 'no_visits', daysSinceLast: null, fraction: 0 }} />,
    )
    expect(progress(container)?.style.getPropertyValue('--ring-to')).toBe(
      String(ringGeometry(0).circumference),
    )
    expect(container).toHaveTextContent('—')
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Ρυθμός επισκέψεων. Δεν έχει ολοκληρωμένη επίσκεψη ακόμη.',
    )
  })
})

describe('E18 under reduced motion (motion.css)', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'shared', 'motion', 'motion.css'), 'utf8')
  const rule = /\.ring-progress \{([^}]*)\}/.exec(css)?.[1] ?? ''
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))

  it('the ring’s resting state is its final offset (what shows when the animation is removed)', () => {
    expect(rule).toContain('stroke-dasharray: var(--circ)')
    expect(rule).toContain('stroke-dashoffset: var(--ring-to, 0)')
    // The fill only moves stroke-dashoffset (ADR-0011 §3.1), from empty to --ring-to.
    expect(css).toMatch(
      /@keyframes ring-fill \{\s*from \{\s*stroke-dashoffset: var\(--circ\);\s*\}\s*to \{\s*stroke-dashoffset: var\(--ring-to, 0\);/,
    )
  })

  it('reduced motion removes every animation: the ring is full at once («γεμάτο αμέσως»)', () => {
    expect(reduced).toContain('animation: none !important')
  })
})
