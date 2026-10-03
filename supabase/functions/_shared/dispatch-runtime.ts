import { configValue, parseAnakloEnv, parseBookingConfig } from './booking-config.ts'
import type { Log, Rpc } from './booking-rpc.ts'
import { buildSenders, parsePushConfigOf, type SenderDeps } from './booking-runtime.ts'
import { EMAIL_CONFIG_VARIABLES, parseEmailConfig } from './email-config.ts'
import { createEmailProvider, type EmailProvider } from './email-provider.ts'
import type { FactorsAdminPort } from './member-functions.ts'
import { PUSH_CONFIG_VARIABLES } from './push-config.ts'
import type { PushProvider } from './push-provider.ts'
import type { SendConfig } from './send.ts'
import type { SmsProvider } from './sms-provider.ts'

/**
 * What `dispatch` builds once at start-up from its environment (contract 1.5 §3.1, §3.5; 1.9
 * §3.3). Pure: `dispatch/index.ts` reads `DISPATCH_ENV_NAMES` from `Deno.env`, passes factories
 * for the service-role `Rpc` and the Auth admin port, and serves every request with the result.
 * An invalid configuration is never partly used: every request answers 500 `not_configured`
 * (since 1.9 also without a valid email configuration: no security event is ever contained
 * without its emails).
 *
 * The OTP test variables of `public-booking` are not read: `dispatch` never claims OTP.
 */

export const DISPATCH_ENV_NAMES = [
  // Injected by the edge runtime (local stack and hosted).
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  // The shared secret pg_net sends (Vault `dispatch_secret`, the same value).
  'DISPATCH_SECRET',
  'ANAKLO_ENV',
  'SITE_HOST',
  'SMS_PROVIDER',
  'SMS_ALLOWED_RECIPIENTS',
  ...PUSH_CONFIG_VARIABLES,
  // 1.9: the security emails (contract 1.9 §3.6).
  ...EMAIL_CONFIG_VARIABLES,
] as const
export type DispatchEnvName = (typeof DISPATCH_ENV_NAMES)[number]
export type DispatchEnv = Partial<Record<DispatchEnvName, string | undefined>>

/** A shorter secret would be guessable; `secrets:dev` generates much longer ones. */
export const MIN_DISPATCH_SECRET_LENGTH = 32

/**
 * The public LOCAL value (`.env.example`, CI, and the seed's Vault `dispatch_secret`). Refused
 * when `ANAKLO_ENV` is prod (or unset), like every other local relaxation.
 */
export const LOCAL_DISPATCH_SECRET = 'local-dev-only-dispatch-secret-not-a-secret-01'

export type DispatchServices = {
  readonly rpc: Rpc
  readonly provider: SmsProvider
  readonly pushProvider: PushProvider
  readonly config: SendConfig
  /** 1.9: the security emails (`email-provider.ts`). */
  readonly emailProvider: EmailProvider
  /** 1.9: `auth.admin.mfa.deleteFactor` of the same service-role client. */
  readonly factors: FactorsAdminPort
  /** 1.9: the Nous address of the security emails (`SUPPORT_EMAIL`). */
  readonly supportEmail: string
}

/** What `dispatch` passes in besides its environment. */
export type DispatchRuntimeDeps = SenderDeps & {
  /** The Auth admin port over the service-role client (`factorsAdminPort`). */
  readonly createFactors: (supabaseUrl: string, serviceRoleKey: string) => FactorsAdminPort
}

export type DispatchRuntime = {
  /** null when the configuration is invalid (then `services` is null too). */
  readonly secret: string | null
  readonly services: DispatchServices | null
  readonly log: Log
}

export function buildDispatchRuntime(env: DispatchEnv, deps: DispatchRuntimeDeps): DispatchRuntime {
  const problems: string[] = []

  const supabaseUrl = configValue(env.SUPABASE_URL)
  const serviceRoleKey = configValue(env.SUPABASE_SERVICE_ROLE_KEY)
  if (supabaseUrl === null) problems.push('SUPABASE_URL: missing')
  if (serviceRoleKey === null) problems.push('SUPABASE_SERVICE_ROLE_KEY: missing')

  const secret = configValue(env.DISPATCH_SECRET)
  if (secret === null) {
    problems.push('DISPATCH_SECRET: required (the same value as Vault dispatch_secret)')
  } else if (secret.length < MIN_DISPATCH_SECRET_LENGTH) {
    problems.push(`DISPATCH_SECRET: at least ${MIN_DISPATCH_SECRET_LENGTH} characters`)
  } else if (secret === LOCAL_DISPATCH_SECRET && parseAnakloEnv(env.ANAKLO_ENV) === 'prod') {
    problems.push('DISPATCH_SECRET: the local value is refused when ANAKLO_ENV is prod (or unset)')
  }

  // The OTP test variables are deliberately not passed: dispatch never sends an OTP.
  const booking = parseBookingConfig({
    ANAKLO_ENV: env.ANAKLO_ENV,
    SITE_HOST: env.SITE_HOST,
    SMS_PROVIDER: env.SMS_PROVIDER,
    SMS_ALLOWED_RECIPIENTS: env.SMS_ALLOWED_RECIPIENTS,
  })
  if (!booking.ok) problems.push(...booking.problems)
  const push = parsePushConfigOf(env)
  if (!push.ok) problems.push(...push.problems)
  const anakloEnv = parseAnakloEnv(env.ANAKLO_ENV)
  const email = parseEmailConfig(env, anakloEnv)
  if (!email.ok) problems.push(...email.problems)

  const notConfigured = (found: string[]): DispatchRuntime => {
    // Names and rules only: no value is ever logged.
    deps.log('not_configured', { problems: found })
    return { secret: null, services: null, log: deps.log }
  }
  if (
    problems.length > 0 ||
    !booking.ok ||
    !push.ok ||
    !email.ok ||
    supabaseUrl === null ||
    serviceRoleKey === null ||
    secret === null
  ) {
    return notConfigured(problems)
  }

  const senders = buildSenders(booking.config, push.config, deps)
  if (!senders.ok) return notConfigured(senders.problems)

  let emailProvider: EmailProvider
  try {
    emailProvider = createEmailProvider({
      env: anakloEnv,
      provider: email.config.provider,
      ...(deps.emailLog === undefined ? {} : { log: deps.emailLog }),
      ...(deps.emailRecord === undefined ? {} : { record: deps.emailRecord }),
    })
  } catch {
    return notConfigured(['EMAIL_PROVIDER: refused for this ANAKLO_ENV'])
  }

  return {
    secret,
    services: {
      rpc: deps.createRpc(supabaseUrl, serviceRoleKey),
      ...senders.senders,
      config: booking.config,
      emailProvider,
      factors: deps.createFactors(supabaseUrl, serviceRoleKey),
      supportEmail: email.config.supportEmail,
    },
    log: deps.log,
  }
}
