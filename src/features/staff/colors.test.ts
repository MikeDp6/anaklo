import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '@/shared/lib/theme'
import { firstFreeColor, paletteColor, STAFF_COLORS } from './colors'

/** `--color-surface` (via `--lux-cream`) as tokens.css defines it. */
function surfaceColor(): string {
  const css = readFileSync(join(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8')
  const match = /--lux-cream:\s*(#[0-9a-fA-F]{6})/.exec(css)
  if (!match?.[1]) throw new Error('--lux-cream not found in tokens.css')
  expect(css).toMatch(/--color-surface:\s*var\(--lux-cream\)/)
  return match[1]
}

describe('STAFF_COLORS (contract 1.6 §4.4)', () => {
  it('8 distinct colours, each ≥ 3:1 against --color-surface (WCAG 1.4.11)', () => {
    const surface = surfaceColor()
    expect(STAFF_COLORS).toHaveLength(8)
    expect(new Set(STAFF_COLORS.map((color) => color.hex.toLowerCase())).size).toBe(8)
    for (const color of STAFF_COLORS) {
      expect(color.hex).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(contrastRatio(color.hex, surface), color.id).toBeGreaterThanOrEqual(3)
    }
  })

  it('a stored colour is a palette colour regardless of case; others are not', () => {
    expect(paletteColor('#2f6b5e')?.id).toBe('green')
    expect(paletteColor('#123456')).toBeNull()
    expect(paletteColor(null)).toBeNull()
  })

  it('a new staff member gets the first colour nobody uses', () => {
    expect(firstFreeColor([])).toBe(STAFF_COLORS[0].hex)
    expect(firstFreeColor(['#2f6b5e', null])).toBe(STAFF_COLORS[1].hex)
    expect(firstFreeColor(STAFF_COLORS.map((color) => color.hex))).toBe(STAFF_COLORS[0].hex)
  })
})
