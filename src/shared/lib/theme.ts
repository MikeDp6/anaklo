import { z } from 'zod/mini'

/**
 * Per-business theme (SPEC §10) over the default direction Δ (ADR-0011). Stored in
 * businesses.theme, applied as CSS variables that override the semantic tokens of tokens.css.
 * Guarantees WCAG AA whatever colour a business picks:
 * - text on the brand colour ≥ 4.5:1 (the brand is darkened or lightened until it is), and the
 *   E1 hover fill (`--color-brand-strong`) only ever moves further away from that text;
 * - brand-coloured indicators (`--color-brand-line`) ≥ 3:1 against page, surface and line;
 * - the focus ring ≥ 3:1 against the page background (falls back to ink).
 */
const HexColor = z.string().check(z.regex(/^#[0-9A-Fa-f]{6}$/))

export const BUSINESS_FONTS = ['manrope'] as const

export const BusinessTheme = z.object({
  primary: z.optional(HexColor),
  accent: z.optional(HexColor),
  surface: z.optional(z.enum(['light', 'dark'])),
  radius: z.optional(z.int().check(z.gte(0), z.lte(32))),
  font: z.optional(z.enum(BUSINESS_FONTS)),
})

export type BusinessTheme = z.infer<typeof BusinessTheme>

const WHITE = '#FFFFFF'
const BLACK = '#000000'
/** Text on a dark brand: --lux-cream. */
export const LIGHT_TEXT = '#FFF9F2'
/** Text on a light brand, and the fallback focus ring: --lux-ink. */
export const DARK_TEXT = '#2B2119'
/** Must match --lux-sand-app, the value of --color-bg in tokens.css (a test checks it). */
export const PAGE_BACKGROUND = '#F3EBE1'
/** --color-surface (--lux-cream): cards, fields, options. */
export const SURFACE = LIGHT_TEXT
/** --color-line (--lux-line): the track of E19 and the dots of E12 sit on it. */
export const LINE = '#DCCDBB'
/** Everything a non-text indicator in the brand colour is drawn next to (tests check tokens.css). */
export const INDICATOR_BACKGROUNDS = [PAGE_BACKGROUND, SURFACE, LINE] as const

/**
 * G6 hero: the scrim colour (--lux-night) and its opacity where text sits (the bottom half,
 * --hero-scrim in tokens.css). Tested with a white photo under it.
 */
export const HERO_SCRIM = { color: '#1C1004', alpha: 0.8 } as const

const TEXT_CONTRAST = 4.5
const FOCUS_CONTRAST = 3
/** How far the E1 hover fill moves away from the brand, toward more contrast with its text. */
const STRONG_STEP = 0.15

type Rgb = [number, number, number]

function toRgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function toHex(rgb: Rgb): string {
  const hex = rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')
  return `#${hex.toUpperCase()}`
}

function channel(value: number): number {
  const srgb = value / 255
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The more readable text colour on top of `background` (cream or ink). */
export function onColor(background: string): string {
  return contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT)
    ? LIGHT_TEXT
    : DARK_TEXT
}

/** `color` moved `amount` (0–1) of the way toward `toward`. */
export function mix(color: string, toward: string, amount: number): string {
  const [r1, g1, b1] = toRgb(color)
  const [r2, g2, b2] = toRgb(toward)
  return toHex([r1 + (r2 - r1) * amount, g1 + (g2 - g1) * amount, b1 + (b2 - b1) * amount])
}

/** `color` at opacity `alpha` over an opaque `background` (a scrim over a photo). */
export function composite(color: string, alpha: number, background: string): string {
  return mix(background, color, alpha)
}

/**
 * The brand colour, adjusted just enough for its text to reach 4.5:1: darkened when light text
 * reads better, lightened when dark text does. Colours that already pass are returned unchanged.
 */
export function readableBrand(brand: string): { background: string; text: string } {
  let background = brand.toUpperCase()
  for (let step = 0; step < 40; step += 1) {
    const text = onColor(background)
    if (contrastRatio(background, text) >= TEXT_CONTRAST) return { background, text }
    background = mix(background, text === LIGHT_TEXT ? BLACK : WHITE, 0.05)
  }
  return { background, text: onColor(background) }
}

/** E1 fill of a brand button: darker under light text, lighter under dark text. */
export function strongBrand(background: string, text: string): string {
  return mix(background, text === LIGHT_TEXT ? BLACK : WHITE, STRONG_STEP)
}

/**
 * The brand as a non-text indicator (E19 fill, selected borders, checkbox/radio, E12 dots):
 * ≥ 3:1 against the page, the surface and the line (WCAG 1.4.11). A brand that passes is kept;
 * a light one (the Δ gold, say) is darkened in its own hue until it does, ink as the last resort.
 * So gold never draws an indicator on a light background («χρυσό μόνο σε σκούρο φόντο»).
 */
export function indicatorBrand(brand: string): string {
  let colour = brand.toUpperCase()
  for (let step = 0; step < 40; step += 1) {
    if (INDICATOR_BACKGROUNDS.every((bg) => contrastRatio(colour, bg) >= FOCUS_CONTRAST)) {
      return colour
    }
    colour = mix(colour, BLACK, 0.05)
  }
  return DARK_TEXT
}

/** `dark` turns on the G6 hero; anything invalid or missing is the light default. */
export function themeSurface(raw: unknown): 'light' | 'dark' {
  const parsed = BusinessTheme.safeParse(raw)
  return parsed.success && parsed.data.surface === 'dark' ? 'dark' : 'light'
}

/** CSS custom properties for a (possibly invalid or partial) stored theme. */
export function themeVariables(raw: unknown): Record<string, string> {
  const parsed = BusinessTheme.safeParse(raw)
  if (!parsed.success) return {}
  const theme = parsed.data
  const vars: Record<string, string> = {}
  if (theme.primary) {
    const { background, text } = readableBrand(theme.primary)
    vars['--color-brand'] = background
    vars['--color-on-brand'] = text
    vars['--color-brand-strong'] = strongBrand(background, text)
    vars['--color-brand-line'] = indicatorBrand(background)
    vars['--color-focus'] =
      contrastRatio(background, PAGE_BACKGROUND) >= FOCUS_CONTRAST ? background : DARK_TEXT
  }
  if (theme.radius !== undefined) vars['--radius-card'] = `${theme.radius}px`
  return vars
}
