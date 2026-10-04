import { z } from 'zod/mini'
import { configValue, type AnakloEnv } from './booking-config.ts'
import type { EmailProviderName } from './email-provider.ts'

/**
 * Email configuration of `dispatch` (contract 1.9 §3.3, §3.6). Pure (ADR-0002 §3): `index.ts`
 * reads the variables from `Deno.env` and passes them in; parsed once at start-up, and an invalid
 * configuration answers 500 `not_configured` on every request (fail closed, like
 * `PUSH_PROVIDER`), so no security event is ever contained without its emails.
 *
 * Problems name the variable and the rule, never the value.
 */

export const EMAIL_PROVIDER_NAMES = ['fake'] as const satisfies readonly EmailProviderName[]

export const EMAIL_CONFIG_VARIABLES = ['EMAIL_PROVIDER', 'SUPPORT_EMAIL'] as const
export type EmailConfigVariable = (typeof EMAIL_CONFIG_VARIABLES)[number]
export type EmailConfigEnv = Partial<Record<EmailConfigVariable, string | undefined>>

export type EmailConfig = {
  readonly provider: EmailProviderName
  /**
   * The Nous address the security emails name and the recipient of the Nous copy of every
   * security event (contract 1.9b §3.2), lower-cased; the real one from 1.10.
   */
  readonly supportEmail: string
}

export type EmailConfigResult =
  { ok: true; config: EmailConfig } | { ok: false; problems: string[] }

/** The synthetic placeholder domain of `.env.example` and CI: never in prod. */
const PLACEHOLDER_DOMAIN = '@example.com'
const MAX_SUPPORT_EMAIL_LENGTH = 254
const SupportEmail = z.email().check(z.maxLength(MAX_SUPPORT_EMAIL_LENGTH))

function isEmailProviderName(value: string): value is EmailProviderName {
  return (EMAIL_PROVIDER_NAMES as readonly string[]).includes(value)
}

/** `env` is the parsed `ANAKLO_ENV` (unset or unknown = prod, `parseAnakloEnv`). */
export function parseEmailConfig(raw: EmailConfigEnv, env: AnakloEnv): EmailConfigResult {
  const problems: string[] = []
  const prod = env === 'prod'

  const provider = configValue(raw.EMAIL_PROVIDER)
  if (provider === null) {
    problems.push(`EMAIL_PROVIDER: required (${EMAIL_PROVIDER_NAMES.join(' | ')})`)
  } else if (!isEmailProviderName(provider)) {
    problems.push(`EMAIL_PROVIDER: unknown (${EMAIL_PROVIDER_NAMES.join(' | ')})`)
  } else if (provider === 'fake' && prod) {
    problems.push('EMAIL_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)')
  }

  const rawSupport = configValue(raw.SUPPORT_EMAIL)
  const supportEmail = rawSupport?.toLowerCase() ?? null
  if (supportEmail === null) {
    problems.push('SUPPORT_EMAIL: required (the Nous address named in security emails)')
  } else if (!SupportEmail.safeParse(supportEmail).success) {
    problems.push('SUPPORT_EMAIL: must be one email address')
  } else if (prod && supportEmail.endsWith(PLACEHOLDER_DOMAIN)) {
    problems.push('SUPPORT_EMAIL: an @example.com address is refused when ANAKLO_ENV is prod')
  }

  if (
    problems.length > 0 ||
    provider === null ||
    !isEmailProviderName(provider) ||
    supportEmail === null
  ) {
    return { ok: false, problems }
  }
  return { ok: true, config: { provider, supportEmail } }
}
