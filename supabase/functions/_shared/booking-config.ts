/**
 * Configuration of the Edge Functions `public-booking` and `manage` (contract 1.3 §7).
 * Pure (ADR-0002 §3): each `index.ts` reads the variables from `Deno.env` and passes them in;
 * `parseBookingConfig` runs once at start-up. An invalid configuration is never partly used:
 * every request then answers 500 `not_configured`.
 *
 * Problems name the variable and the rule, never the value.
 */

export const ANAKLO_ENVS = ['local', 'dev', 'prod'] as const
export type AnakloEnv = (typeof ANAKLO_ENVS)[number]

/** Only the fake adapter exists until the real provider (ADR-0012, step 1.10). */
export const SMS_PROVIDER_NAMES = ['fake'] as const
export type SmsProviderName = (typeof SMS_PROVIDER_NAMES)[number]

/**
 * `SITE_HOST/m/<22>` must fit the 40-septet link budget of ADR-0007 (15 + 3 + 22), and
 * `SITE_HOST` without the port the 20-septet `domain` of the OTP template.
 */
export const MAX_SITE_HOST_LENGTH = 15

/** The variables this module reads, for `index.ts` (`Deno.env.get(name)` for each). */
export const BOOKING_CONFIG_VARIABLES = [
  'ANAKLO_ENV',
  'SITE_HOST',
  'SMS_PROVIDER',
  'OTP_TEST_NUMBERS',
  'OTP_TEST_CODE',
  'SMS_ALLOWED_RECIPIENTS',
] as const
export type BookingConfigVariable = (typeof BOOKING_CONFIG_VARIABLES)[number]
export type BookingConfigEnv = Partial<Record<BookingConfigVariable, string | undefined>>

export type BookingConfig = {
  readonly env: AnakloEnv
  /** `localhost:5173`, `dev.anaklo.gr`: the host of the SMS links, without a scheme. */
  readonly siteHost: string
  /** `siteHost` without the port: the `@domain` of the OTP SMS (WebOTP). */
  readonly smsDomain: string
  readonly smsProvider: SmsProviderName
  /** Numbers that get `otpTestCode` instead of a random code. Never in prod. */
  readonly otpTestNumbers: ReadonlySet<string>
  readonly otpTestCode: string | null
  /** Empty = no filter. Otherwise only these numbers are sent to (others: `rejected`). */
  readonly allowedRecipients: ReadonlySet<string>
}

export type BookingConfigResult =
  { ok: true; config: BookingConfig } | { ok: false; problems: string[] }

/** The Supabase CLI passes an unresolved `env(NAME)` from config.toml through literally. */
const UNRESOLVED_ENV_REFERENCE = /^env\(.*\)$/
const SITE_HOST = /^[a-z0-9.-]+(:[0-9]{2,5})?$/
const GREEK_MOBILE = /^\+3069\d{8}$/
const E164 = /^\+[1-9]\d{7,14}$/
const OTP_TEST_CODE = /^\d{6}$/

/** Empty, whitespace or `env(NAME)` count as unset. */
export function configValue(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '' || UNRESOLVED_ENV_REFERENCE.test(value)) return null
  return value
}

/** Unset or unknown → `prod`: the fail-safe that refuses every test relaxation. */
export function parseAnakloEnv(raw: string | null | undefined): AnakloEnv {
  const value = configValue(raw)
  return (ANAKLO_ENVS as readonly string[]).includes(value ?? '') ? (value as AnakloEnv) : 'prod'
}

function isSmsProviderName(value: string): value is SmsProviderName {
  return (SMS_PROVIDER_NAMES as readonly string[]).includes(value)
}

/** A comma list; blanks between commas are ignored, duplicates collapse. */
function parseList(value: string | null): string[] {
  if (value === null) return []
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    ),
  ]
}

export function parseBookingConfig(raw: BookingConfigEnv): BookingConfigResult {
  const problems: string[] = []
  const env = parseAnakloEnv(raw.ANAKLO_ENV)
  const prod = env === 'prod'

  const siteHost = configValue(raw.SITE_HOST)
  if (siteHost === null) {
    problems.push('SITE_HOST: required (e.g. localhost:5173 or dev.anaklo.gr)')
  } else if (!SITE_HOST.test(siteHost)) {
    problems.push('SITE_HOST: must be a lower-case host with an optional port, without a scheme')
  } else if (siteHost.length > MAX_SITE_HOST_LENGTH) {
    problems.push(`SITE_HOST: at most ${MAX_SITE_HOST_LENGTH} characters (SMS link budget)`)
  }

  const provider = configValue(raw.SMS_PROVIDER)
  if (provider === null) {
    problems.push(`SMS_PROVIDER: required (${SMS_PROVIDER_NAMES.join(' | ')})`)
  } else if (!isSmsProviderName(provider)) {
    problems.push(`SMS_PROVIDER: unknown (${SMS_PROVIDER_NAMES.join(' | ')})`)
  } else if (provider === 'fake' && prod) {
    problems.push('SMS_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)')
  }

  const testNumbers = parseList(configValue(raw.OTP_TEST_NUMBERS))
  const testCode = configValue(raw.OTP_TEST_CODE)
  if (testNumbers.some((number) => !GREEK_MOBILE.test(number))) {
    problems.push('OTP_TEST_NUMBERS: every entry must be a +3069 mobile in E.164')
  }
  if (testCode !== null && !OTP_TEST_CODE.test(testCode)) {
    problems.push('OTP_TEST_CODE: must be 6 digits')
  }
  if (testNumbers.length > 0 !== (testCode !== null)) {
    problems.push('OTP_TEST_NUMBERS and OTP_TEST_CODE: set both or neither')
  }
  if (prod && (testNumbers.length > 0 || testCode !== null)) {
    problems.push('OTP_TEST_NUMBERS / OTP_TEST_CODE: refused when ANAKLO_ENV is prod (or unset)')
  }

  const allowed = parseList(configValue(raw.SMS_ALLOWED_RECIPIENTS))
  if (allowed.some((number) => !E164.test(number))) {
    problems.push('SMS_ALLOWED_RECIPIENTS: every entry must be E.164')
  }
  if (prod && allowed.length > 0) {
    problems.push('SMS_ALLOWED_RECIPIENTS: refused when ANAKLO_ENV is prod (or unset)')
  }

  if (problems.length > 0 || siteHost === null || provider === null || !isSmsProviderName(provider))
    return { ok: false, problems }

  return {
    ok: true,
    config: {
      env,
      siteHost,
      smsDomain: siteHost.replace(/:\d+$/, ''),
      smsProvider: provider,
      otpTestNumbers: new Set(testNumbers),
      otpTestCode: testCode,
      allowedRecipients: new Set(allowed),
    },
  }
}

/** The fixed code for a test number, or null (SQL then draws a random one). */
export function otpCodeFor(config: BookingConfig, phone: string): string | null {
  if (config.env === 'prod' || config.otpTestCode === null) return null
  return config.otpTestNumbers.has(phone) ? config.otpTestCode : null
}
