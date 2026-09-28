/**
 * Server-side injection into the booking page shell (ADR-0008 §5): title, description, Open
 * Graph, theme colour, language and the initial data, so link previews (Instagram, WhatsApp,
 * Viber) work without JavaScript. A pure string function shared by the Worker and the Vite dev
 * server; not HTMLRewriter, which only exists in workerd. It has no texts of its own: every
 * string comes from `data` (from the database or the booking page catalogues).
 */

export type BookingShellData = {
  /** `<title>` and `og:title`. */
  title: string
  /** `meta description` and `og:description`; omitted when empty. */
  description?: string | undefined
  /** Canonical page URL for `og:url`; omitted when not given. */
  url?: string | undefined
  /** `#rrggbb` for `meta theme-color`; ignored unless it is one. */
  themeColor?: string | undefined
  /** `<html lang>`; ignored unless it is a two-letter code. */
  lang?: string | undefined
  /** Embedded as `<script id="anaklo-initial" type="application/json">`. */
  initial?: unknown
}

export const INITIAL_DATA_ELEMENT_ID = 'anaklo-initial'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes text and attribute values: `& < > " '` become entities. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

/**
 * JSON that is safe inside a `<script>` element: `<` (so neither `</script>` nor `<!--` can
 * appear), `>` and `&` become unicode escapes, and so do U+2028/U+2029.
 */
export function serializeJsonForScript(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const TITLE = /<title>[\s\S]*?<\/title>/i
const THEME_COLOR_META = /[ \t]*<meta\s+name=["']theme-color["'][^>]*>[ \t]*\r?\n?/gi
const DESCRIPTION_META = /[ \t]*<meta\s+name=["']description["'][^>]*>[ \t]*\r?\n?/gi
const OPEN_GRAPH_META = /[ \t]*<meta\s+property=["']og:[^"']*["'][^>]*>[ \t]*\r?\n?/gi
const INITIAL_SCRIPT = /[ \t]*<script\s+id=["']anaklo-initial["'][\s\S]*?<\/script>[ \t]*\r?\n?/gi
const HTML_LANG = /(<html\b[^>]*?\blang=)(["'])[^"']*\2/i
const HEAD_END = /[ \t]*<\/head>/i
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/
const LANG = /^[a-z]{2}$/

function meta(attribute: 'name' | 'property', key: string, content: string): string {
  return `<meta ${attribute}="${key}" content="${escapeHtml(content)}" />`
}

function headTags(data: BookingShellData, description: string, themeColor: string | null) {
  const tags: string[] = []
  if (description) tags.push(meta('name', 'description', description))
  if (themeColor) tags.push(meta('name', 'theme-color', themeColor))
  tags.push(meta('property', 'og:type', 'website'))
  tags.push(meta('property', 'og:title', data.title))
  if (description) tags.push(meta('property', 'og:description', description))
  if (data.url) tags.push(meta('property', 'og:url', data.url))
  if (data.initial !== undefined) {
    const json = serializeJsonForScript(data.initial)
    tags.push(`<script id="${INITIAL_DATA_ELEMENT_ID}" type="application/json">${json}</script>`)
  }
  return tags
}

/**
 * Returns the shell with the business's head tags. `null` returns the shell unchanged (unknown
 * slug, or Supabase did not answer). Replacements use functions, never replacement strings,
 * so `$&` or `$'` in a business name stay literal. The shell's own theme colour stays unless
 * `data` brings a valid one.
 */
export function injectBookingShell(html: string, data: BookingShellData | null): string {
  if (data === null) return html
  const description = data.description?.trim() ?? ''
  const themeColor = data.themeColor && HEX_COLOR.test(data.themeColor) ? data.themeColor : null

  let result = html
    .replace(DESCRIPTION_META, () => '')
    .replace(OPEN_GRAPH_META, () => '')
    .replace(INITIAL_SCRIPT, () => '')
  if (themeColor) result = result.replace(THEME_COLOR_META, () => '')

  const title = `<title>${escapeHtml(data.title)}</title>`
  result = TITLE.test(result)
    ? result.replace(TITLE, () => title)
    : result.replace(HEAD_END, (end) => `    ${title}\n${end}`)

  const lang = data.lang && LANG.test(data.lang) ? data.lang : null
  if (lang) {
    result = result.replace(HTML_LANG, (_match, start: string, quote: string) => {
      return `${start}${quote}${lang}${quote}`
    })
  }

  const block = headTags(data, description, themeColor)
    .map((tag) => `    ${tag}\n`)
    .join('')
  return result.replace(HEAD_END, () => `${block}  </head>`)
}
