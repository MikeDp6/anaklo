import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  composite,
  contrastRatio,
  DARK_TEXT,
  HERO_SCRIM,
  indicatorBrand,
  INDICATOR_BACKGROUNDS,
  LIGHT_TEXT,
  LINE,
  onColor,
  PAGE_BACKGROUND,
  readableBrand,
  SURFACE,
  themeSurface,
  themeVariables,
} from './theme'

const WHITE = '#FFFFFF'
const AA_TEXT = 4.5
const AA_LARGE_TEXT = 3
const AA_NON_TEXT = 3

/** The custom properties of tokens.css, with var() references resolved. */
function readTokens(): Record<string, string> {
  const css = readFileSync(join(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8')
  const raw: Record<string, string> = {}
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    raw[match[1] ?? ''] = (match[2] ?? '').trim().replace(/\s+/g, ' ')
  }
  const resolve = (value: string, depth = 0): string =>
    depth > 10
      ? value
      : value.replace(/var\((--[\w-]+)\)/g, (_, name: string) =>
          resolve(raw[name] ?? `<missing ${name}>`, depth + 1),
        )
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, resolve(value)]))
}

const tokens = readTokens()

/** A token that must be a plain #rrggbb colour. */
function color(name: string): string {
  const value = tokens[name]
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a hex colour`)
  return value.toUpperCase()
}

describe('contrast', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 0)
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1)
  })

  it('picks readable text on a brand colour (cream or ink)', () => {
    expect(onColor('#C8A15A')).toBe(DARK_TEXT) // gold → ink
    expect(onColor('#1F3A5F')).toBe(LIGHT_TEXT) // navy → cream
  })

  it('leaves brand colours that already pass unchanged', () => {
    expect(readableBrand('#1F3A5F').background).toBe('#1F3A5F')
    expect(readableBrand('#C8A15A').background).toBe('#C8A15A')
  })
})

describe('the default palette Δ (tokens.css) passes WCAG AA where MOTION.md uses it', () => {
  it('PAGE_BACKGROUND is --color-bg (sand-app)', () => {
    expect(color('--color-bg')).toBe(PAGE_BACKGROUND)
    expect(color('--lux-sand-app')).toBe(PAGE_BACKGROUND)
  })

  it('theme.ts text colours are the palette cream and ink', () => {
    expect(color('--lux-cream')).toBe(LIGHT_TEXT)
    expect(color('--lux-ink')).toBe(DARK_TEXT)
    expect(color('--color-on-brand')).toBe(onColor(color('--color-brand')))
  })

  it.each([
    ['--color-ink', '--color-bg'],
    ['--color-ink', '--color-surface'],
    ['--color-muted', '--color-bg'],
    ['--color-muted', '--color-surface'],
    ['--color-danger', '--color-bg'],
    ['--color-danger', '--color-surface'],
    ['--color-on-brand', '--color-brand'],
    ['--color-on-brand', '--color-brand-strong'], // E1 fill under the label
    ['--color-brand', '--color-bg'], // brand-coloured text links
    ['--color-brand', '--color-surface'],
    ['--color-ink-on-dark', '--color-bg-dark'],
    ['--color-ink-on-dark', '--color-surface-dark'],
  ])('text %s on %s ≥ 4.5:1', (text, background) => {
    expect(contrastRatio(color(text), color(background))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('bronze (G1 labels, accent titles) reaches 4.5:1 on the app backgrounds, so 14px bold is safe', () => {
    for (const background of ['--color-bg', '--color-surface']) {
      expect(contrastRatio(color('--color-accent'), color(background))).toBeGreaterThanOrEqual(
        AA_TEXT,
      )
    }
    // On the marketing sand it is for large titles only.
    expect(contrastRatio(color('--lux-bronze'), color('--lux-sand'))).toBeGreaterThanOrEqual(
      AA_LARGE_TEXT,
    )
  })

  it('gold passes only on dark: ≥ 4.5:1 on night/espresso, < 3:1 on any light background', () => {
    const gold = color('--color-accent-on-dark')
    expect(contrastRatio(gold, color('--color-bg-dark'))).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrastRatio(gold, color('--color-surface-dark'))).toBeGreaterThanOrEqual(AA_TEXT)
    for (const light of ['--color-bg', '--color-surface', '--lux-sand']) {
      expect(contrastRatio(gold, color(light))).toBeLessThan(AA_LARGE_TEXT)
    }
  })

  it('theme.ts knows the surface and the line of the palette', () => {
    expect(color('--color-surface')).toBe(SURFACE)
    expect(color('--color-line')).toBe(LINE)
    expect(INDICATOR_BACKGROUNDS).toEqual([
      color('--color-bg'),
      color('--color-surface'),
      color('--color-line'),
    ])
  })

  it('brand indicators (E19 fill, selected borders, checkbox/radio, dots) are ≥ 3:1 on bg, surface and line', () => {
    for (const background of ['--color-bg', '--color-surface', '--color-line']) {
      expect(contrastRatio(color('--color-brand-line'), color(background))).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      )
    }
  })

  it('field borders and the focus ring are ≥ 3:1 (WCAG 1.4.11)', () => {
    for (const background of ['--color-bg', '--color-surface']) {
      expect(
        contrastRatio(color('--color-control-border'), color(background)),
      ).toBeGreaterThanOrEqual(AA_NON_TEXT)
      expect(contrastRatio(color('--color-focus'), color(background))).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      )
    }
  })

  it('G3 glass button: cream text on white 20% over dark ≥ 4.5:1', () => {
    expect(tokens['--color-glass']).toBe('rgb(255 255 255 / 0.2)')
    for (const dark of ['--color-bg-dark', '--color-surface-dark']) {
      const glass = composite(WHITE, 0.2, color(dark))
      expect(contrastRatio(color('--color-ink-on-dark'), glass)).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('G6 hero: text over the scrim stays ≥ 4.5:1 even over a white photo', () => {
    expect(tokens['--hero-scrim-alpha']).toBe(String(HERO_SCRIM.alpha))
    expect(color('--lux-night')).toBe(HERO_SCRIM.color)
    const worstCase = composite(HERO_SCRIM.color, HERO_SCRIM.alpha, WHITE)
    expect(contrastRatio(color('--color-ink-on-dark'), worstCase)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrastRatio(color('--color-accent-on-dark'), worstCase)).toBeGreaterThanOrEqual(
      AA_TEXT,
    )
  })
})

describe('any brand colour a business picks stays accessible', () => {
  // Every 17th value per channel: 16³ = 4096 colours, including the mid-luminance ones where
  // neither light nor dark text reaches 4.5:1 without adjusting the brand.
  const steps = Array.from({ length: 16 }, (_, i) => i * 17)
  const colours = steps.flatMap((r) =>
    steps.flatMap((g) =>
      steps.map((b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`),
    ),
  )
  const themed = colours.map((colour) => themeVariables({ primary: colour.toUpperCase() }))

  it('text on the (adjusted) brand is always ≥ 4.5:1', () => {
    const failing = themed.filter(
      (vars) => contrastRatio(vars['--color-brand']!, vars['--color-on-brand']!) < AA_TEXT,
    )
    expect(failing).toEqual([])
  })

  it('the E1 hover fill keeps at least the contrast of the brand itself', () => {
    const failing = themed.filter(
      (vars) =>
        contrastRatio(vars['--color-brand-strong']!, vars['--color-on-brand']!) <
        contrastRatio(vars['--color-brand']!, vars['--color-on-brand']!),
    )
    expect(failing).toEqual([])
  })

  it('the focus ring is always ≥ 3:1 against the page', () => {
    const failing = themed.filter(
      (vars) => contrastRatio(vars['--color-focus']!, PAGE_BACKGROUND) < AA_NON_TEXT,
    )
    expect(failing).toEqual([])
  })

  it('brand indicators are always ≥ 3:1 against the page, the surface and the line', () => {
    const failing = themed.filter((vars) =>
      INDICATOR_BACKGROUNDS.some(
        (background) => contrastRatio(vars['--color-brand-line']!, background) < AA_NON_TEXT,
      ),
    )
    expect(failing).toEqual([])
  })
})

describe('non-text indicators never use the raw brand (it may be a light gold)', () => {
  // Every CSS module of the app: borders, rings, accent colours and strokes that mark a state.
  const root = join(process.cwd(), 'src')
  const modules = (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.module.css'))
    .map((file) => ({ file, css: readFileSync(join(root, file), 'utf8') }))

  it('border, outline, ring, accent and stroke colours use --color-brand-line', () => {
    const indicator =
      /(?:border(?:-[a-z]+)?|outline(?:-color)?|box-shadow|accent-color|stroke)\s*:[^;]*var\(--color-brand\)/g
    const found = modules.flatMap(({ file, css }) =>
      [...css.matchAll(indicator)].map((match) => `${file}: ${match[0]}`),
    )
    expect(found).toEqual([])
  })

  it('the «Κατειλημμένο» label of the day view reads at 4.5:1 on both of its stripes', () => {
    const css = modules.find(({ file }) => file.endsWith('DayView.module.css'))?.css ?? ''
    const busy = /\.busy\s*{([^}]*)}/.exec(css)?.[1] ?? ''
    const text = /(?:^|\s)color:\s*var\((--[\w-]+)\)/.exec(busy)?.[1]
    const stripes = [...busy.matchAll(/var\((--[\w-]+)\)\s+\d+(?:px)?/g)].map((m) => m[1] ?? '')
    expect(text).toBeDefined()
    expect(new Set(stripes)).toEqual(new Set(['--color-skeleton', '--color-surface']))
    for (const stripe of stripes) {
      expect(contrastRatio(color(text ?? ''), color(stripe))).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('the E19 progress fill and the active E12 dot use --color-brand-line', () => {
    const css = (name: string) => modules.find(({ file }) => file.endsWith(name))?.css ?? ''
    expect(css('ProgressBar.module.css')).toMatch(
      /\.bar\s*{[^}]*background:\s*var\(--color-brand-line\)/,
    )
    expect(css('StaffCarousel.module.css')).toMatch(
      /\.dot\[data-active='true'\]\s*{[^}]*background:\s*var\(--color-brand-line\)/,
    )
  })
})

describe('themeVariables', () => {
  it('maps a stored theme to CSS variables', () => {
    expect(themeVariables({ primary: '#1F3A5F', radius: 12 })).toEqual({
      '--color-brand': '#1F3A5F',
      '--color-on-brand': LIGHT_TEXT,
      '--color-brand-strong': '#1A3151',
      '--color-brand-line': '#1F3A5F',
      '--color-focus': '#1F3A5F',
      '--radius-card': '12px',
    })
  })

  it('draws the indicators of a light gold brand (the demo shop) in a darker gold, never in gold', () => {
    const vars = themeVariables({ primary: '#C8A15A' })
    const line = vars['--color-brand-line']!
    expect(vars['--color-brand']).toBe('#C8A15A') // buttons keep the brand, with ink text
    expect(line).not.toBe('#C8A15A')
    expect(line).not.toBe(DARK_TEXT) // darkened in its own hue, not replaced
    for (const background of INDICATOR_BACKGROUNDS) {
      expect(contrastRatio(line, background)).toBeGreaterThanOrEqual(AA_NON_TEXT)
    }
    expect(indicatorBrand('#503011')).toBe('#503011') // a brand that passes is kept
  })

  it('lightens the hover fill of a light brand with dark text', () => {
    const vars = themeVariables({ primary: '#C8A15A' })
    expect(vars['--color-on-brand']).toBe(DARK_TEXT)
    expect(vars['--color-brand-strong']).toBe('#D0AF73')
  })

  it('uses an ink focus ring when the brand is too light to see on the page', () => {
    expect(themeVariables({ primary: '#C8A15A' })['--color-focus']).toBe(DARK_TEXT)
  })

  it('only sets what the theme defines (the Δ tokens stay otherwise)', () => {
    expect(themeVariables({})).toEqual({})
    expect(themeVariables({ radius: 0 })).toEqual({ '--radius-card': '0px' })
  })

  it('ignores invalid themes instead of breaking the page', () => {
    expect(themeVariables({ primary: 'red' })).toEqual({})
    expect(themeVariables(null)).toEqual({})
  })
})

describe('themeSurface', () => {
  it('is dark only when the theme says so', () => {
    expect(themeSurface({ surface: 'dark' })).toBe('dark')
    expect(themeSurface({ surface: 'light' })).toBe('light')
    expect(themeSurface({})).toBe('light')
    expect(themeSurface({ surface: 'purple' })).toBe('light')
    expect(themeSurface(null)).toBe('light')
  })
})
