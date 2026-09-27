import { z } from 'zod/mini'

/**
 * Per-business theme (SPEC §10). Stored in businesses.theme, applied as CSS variables.
 * Guarantees WCAG AA whatever colour a business picks:
 * - text on the brand colour ≥ 4.5:1 (the brand is darkened or lightened until it is);
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
const INK = '#14171C'
/** Must match --color-bg in tokens.css (a test checks it). */
export const PAGE_BACKGROUND = '#F6F5F2'

const TEXT_CONTRAST = 4.5
const FOCUS_CONTRAST = 3

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

/** The more readable text colour on top of `background` (white or near-black). */
export function onColor(background: string): string {
  return contrastRatio(background, WHITE) >= contrastRatio(background, INK) ? WHITE : INK
}

function mix(color: string, toward: string, amount: number): string {
  const [r1, g1, b1] = toRgb(color)
  const [r2, g2, b2] = toRgb(toward)
  return toHex([r1 + (r2 - r1) * amount, g1 + (g2 - g1) * amount, b1 + (b2 - b1) * amount])
}

/**
 * The brand colour, adjusted just enough for its text to reach 4.5:1: darkened when white text
 * reads better, lightened when dark text does. Colours that already pass are returned unchanged.
 */
export function readableBrand(brand: string): { background: string; text: string } {
  let background = brand.toUpperCase()
  for (let step = 0; step < 40; step += 1) {
    const text = onColor(background)
    if (contrastRatio(background, text) >= TEXT_CONTRAST) return { background, text }
    background = mix(background, text === WHITE ? BLACK : WHITE, 0.05)
  }
  return { background, text: onColor(background) }
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
    vars['--color-focus'] =
      contrastRatio(background, PAGE_BACKGROUND) >= FOCUS_CONTRAST ? background : INK
  }
  if (theme.radius !== undefined) vars['--radius-card'] = `${theme.radius}px`
  return vars
}
