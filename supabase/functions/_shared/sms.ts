/**
 * SMS text preparation (ADR-0007).
 *
 * Greek lower case forces UCS-2 (70 characters per SMS). Upper-case Greek without accents fits
 * GSM-7 (160 characters) because Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω are in the GSM-7 alphabet and the other
 * capitals look exactly like Latin letters. Templates are written normally (sms-templates.ts);
 * every SMS passes through `prepareSms` before it is sent or measured.
 */

const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
)
/** Characters from the GSM-7 extension table cost two septets each (escape + char). */
const GSM7_EXTENSION = new Set('^{}\\[~]|€\f')

const GREEK_LOOKALIKE_TO_LATIN: Readonly<Record<string, string>> = {
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
}

// Written as code points so that invisible characters stay visible in review.
const TYPOGRAPHY_CODE_POINTS: ReadonlyArray<readonly [number, string]> = [
  [0x2018, "'"], // ‘
  [0x2019, "'"], // ’
  [0x201c, '"'], // “
  [0x201d, '"'], // ”
  [0x00ab, '"'], // «
  [0x00bb, '"'], // »
  [0x2010, '-'], // hyphen
  [0x2011, '-'], // non-breaking hyphen
  [0x2013, '-'], // –
  [0x2014, '-'], // —
  [0x2212, '-'], // minus sign
  [0x2026, '...'], // …
  [0x00a0, ' '], // no-break space
  [0x202f, ' '], // narrow no-break space
  [0x2009, ' '], // thin space
  [0x00b7, ';'], // Greek ano teleia: U+0387 becomes U+00B7 under NFC
  [0x0387, ';'],
]
const TYPOGRAPHY_MAP: ReadonlyMap<string, string> = new Map(
  TYPOGRAPHY_CODE_POINTS.map(([codePoint, replacement]) => [
    String.fromCodePoint(codePoint),
    replacement,
  ]),
)

const COMBINING_MARKS = /\p{Mn}/gu
const GREEK_LOWER = /[α-ω]/g

/**
 * Greek → upper case without accents, look-alike capitals → Latin, smart punctuation → ASCII.
 * Latin text (links, tokens, names written in Latin) keeps its case.
 */
export function toGsm7Text(text: string): string {
  const withoutMarks = text.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC')
  const upperGreek = withoutMarks.replace(GREEK_LOWER, (char) => char.toUpperCase())
  let out = ''
  for (const char of upperGreek) {
    out += GREEK_LOOKALIKE_TO_LATIN[char] ?? TYPOGRAPHY_MAP.get(char) ?? char
  }
  return out
}

/** Number of GSM-7 septets, or null when the text cannot be sent as GSM-7. */
export function gsm7Septets(text: string): number | null {
  let septets = 0
  for (const char of text) {
    if (GSM7_BASIC.has(char)) septets += 1
    else if (GSM7_EXTENSION.has(char)) septets += 2
    else return null
  }
  return septets
}

export type SmsAnalysis = {
  encoding: 'GSM-7' | 'UCS-2'
  /** septets for GSM-7, UTF-16 code units for UCS-2 */
  units: number
  segments: number
}

export function analyzeSms(text: string): SmsAnalysis {
  const septets = gsm7Septets(text)
  if (septets !== null) {
    return {
      encoding: 'GSM-7',
      units: septets,
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
    }
  }
  const units = text.length
  return { encoding: 'UCS-2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67) }
}

export type PreparedSms = SmsAnalysis & {
  text: string
  /** characters that had no GSM-7 form (emoji, other scripts) and were replaced with '?' */
  replaced: string[]
}

function isGsm7Char(char: string): boolean {
  return GSM7_BASIC.has(char) || GSM7_EXTENSION.has(char)
}

function septetsOf(char: string): number {
  return GSM7_EXTENSION.has(char) ? 2 : 1
}

/** Converts, then replaces anything still outside GSM-7 with '?' (reported in `replaced`). */
function forceGsm7(text: string): { text: string; replaced: string[] } {
  const replaced: string[] = []
  let safe = ''
  for (const char of toGsm7Text(text)) {
    if (isGsm7Char(char)) {
      safe += char
    } else {
      replaced.push(char)
      safe += '?'
    }
  }
  return { text: safe, replaced }
}

/**
 * The only way an SMS body leaves the app: converted, forced into GSM-7, then measured.
 * One stray character (an emoji in a name, a curly quote) would otherwise switch the whole
 * message to UCS-2 and triple its cost, so anything left over becomes '?' and is reported.
 */
export function prepareSms(text: string): PreparedSms {
  const { text: safe, replaced } = forceGsm7(text)
  return { text: safe, replaced, ...analyzeSms(safe) }
}

/**
 * Upper bounds for template variables, in GSM-7 SEPTETS after conversion (an extension character
 * such as € or [ costs two, '…' becomes '...'). Templates are tested with values at exactly these
 * budgets and must still fit in one GSM-7 SMS; values pass through `clipForSms`.
 */
export const SMS_VARIABLE_LIMITS = {
  business: 24,
  staff: 16,
  client: 16,
  date: 9,
  time: 5,
  link: 40,
  code: 6,
  domain: 20,
} as const

export type SmsVariable = keyof typeof SMS_VARIABLE_LIMITS

/**
 * Values that must reach the phone exactly: a clipped link is broken, a clipped date or time is
 * wrong information. An over-long one is a programming error, never silently shortened.
 */
const EXACT_VARIABLES: ReadonlySet<SmsVariable> = new Set([
  'link',
  'code',
  'domain',
  'date',
  'time',
])

/**
 * Converts a value to its GSM-7 form and fits it into its septet budget: names are clipped,
 * exact values (links, codes, dates, times) throw instead.
 */
export function clipForSms(variable: SmsVariable, value: string): string {
  const limit = SMS_VARIABLE_LIMITS[variable]
  const converted = forceGsm7(value.trim()).text
  let used = 0
  let out = ''
  for (const char of converted) {
    const cost = septetsOf(char)
    if (used + cost > limit) {
      if (EXACT_VARIABLES.has(variable)) {
        throw new RangeError(`SMS ${variable} needs more than ${limit} septets: ${value}`)
      }
      break
    }
    out += char
    used += cost
  }
  return out
}
