import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, onColor, PAGE_BACKGROUND, readableBrand, themeVariables } from './theme'

describe('contrast', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 0)
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1)
  })

  it('picks readable text on a brand colour', () => {
    expect(onColor('#C8A15A')).toBe('#14171C') // gold → dark text
    expect(onColor('#1F3A5F')).toBe('#FFFFFF') // navy → white text
  })

  it('leaves brand colours that already pass unchanged', () => {
    expect(readableBrand('#1F3A5F').background).toBe('#1F3A5F')
    expect(readableBrand('#C8A15A').background).toBe('#C8A15A')
  })
})

describe('any brand colour a business picks stays accessible', () => {
  // Every 17th value per channel: 16³ = 4096 colours, including the mid-luminance ones where
  // neither white nor dark text reaches 4.5:1 without adjusting the brand.
  const steps = Array.from({ length: 16 }, (_, i) => i * 17)
  const colours = steps.flatMap((r) =>
    steps.flatMap((g) =>
      steps.map((b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`),
    ),
  )

  it('text on the (adjusted) brand is always ≥ 4.5:1', () => {
    const failing = colours.filter((colour) => {
      const vars = themeVariables({ primary: colour.toUpperCase() })
      return contrastRatio(vars['--color-brand']!, vars['--color-on-brand']!) < 4.5
    })
    expect(failing).toEqual([])
  })

  it('the focus ring is always ≥ 3:1 against the page', () => {
    const failing = colours.filter((colour) => {
      const vars = themeVariables({ primary: colour.toUpperCase() })
      return contrastRatio(vars['--color-focus']!, PAGE_BACKGROUND) < 3
    })
    expect(failing).toEqual([])
  })
})

describe('themeVariables', () => {
  it('maps a stored theme to CSS variables', () => {
    expect(themeVariables({ primary: '#1F3A5F', radius: 12 })).toEqual({
      '--color-brand': '#1F3A5F',
      '--color-on-brand': '#FFFFFF',
      '--color-focus': '#1F3A5F',
      '--radius-card': '12px',
    })
  })

  it('uses an ink focus ring when the brand is too light to see on the page', () => {
    expect(themeVariables({ primary: '#C8A15A' })['--color-focus']).toBe('#14171C')
  })

  it('ignores invalid themes instead of breaking the page', () => {
    expect(themeVariables({ primary: 'red' })).toEqual({})
    expect(themeVariables(null)).toEqual({})
  })

  it('PAGE_BACKGROUND matches --color-bg in tokens.css', () => {
    const tokens = readFileSync(join(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8')
    expect(tokens.toLowerCase()).toContain(`--color-bg: ${PAGE_BACKGROUND.toLowerCase()};`)
  })
})
