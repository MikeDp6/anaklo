import {
  BOOKING_CONFIG_VARIABLES,
  configValue,
  parseBookingConfig,
  type BookingConfig,
} from './booking-config.ts'
import type { Log, Rpc } from './booking-rpc.ts'
import { errorResponse } from './http.ts'
import { createSmsProvider, type SmsProvider, type SmsProviderLog } from './sms-provider.ts'

/**
 * What `public-booking` and `manage` build once at start-up from their environment. Pure: each
 * `index.ts` reads `BOOKING_ENV_NAMES` from `Deno.env`, passes a factory for the service-role
 * `Rpc`, and serves every request with the result.
 */

export const BOOKING_ENV_NAMES = [
  'PROXY_SECRET',
  // Injected by the edge runtime (local stack and hosted).
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  ...BOOKING_CONFIG_VARIABLES,
] as const
export type BookingEnvName = (typeof BOOKING_ENV_NAMES)[number]
export type BookingEnv = Partial<Record<BookingEnvName, string | undefined>>

export type BookingServices = {
  readonly rpc: Rpc
  readonly provider: SmsProvider
  readonly config: BookingConfig
}

export type BookingRuntime = {
  readonly proxySecret: string | undefined
  /** null: the configuration is invalid and every request answers 500 `not_configured`. */
  readonly services: BookingServices | null
  readonly log: Log
}

export type BuildBookingRuntimeDeps = {
  readonly createRpc: (supabaseUrl: string, serviceRoleKey: string) => Rpc
  readonly log: Log
  /** Where the fake SMS adapter prints texts with `ANAKLO_ENV=local` (default: console). */
  readonly providerLog?: SmsProviderLog
}

export function buildBookingRuntime(
  env: BookingEnv,
  deps: BuildBookingRuntimeDeps,
): BookingRuntime {
  const notConfigured = (problems: string[]): BookingRuntime => {
    // Names and rules only: no value is ever logged.
    deps.log('not_configured', { problems })
    return { proxySecret: env.PROXY_SECRET, services: null, log: deps.log }
  }

  const problems: string[] = []
  const supabaseUrl = configValue(env.SUPABASE_URL)
  const serviceRoleKey = configValue(env.SUPABASE_SERVICE_ROLE_KEY)
  if (supabaseUrl === null) problems.push('SUPABASE_URL: missing')
  if (serviceRoleKey === null) problems.push('SUPABASE_SERVICE_ROLE_KEY: missing')
  const parsed = parseBookingConfig(env)
  if (!parsed.ok) problems.push(...parsed.problems)
  if (!parsed.ok || supabaseUrl === null || serviceRoleKey === null) return notConfigured(problems)

  let provider: SmsProvider
  try {
    provider = createSmsProvider({
      env: parsed.config.env,
      provider: parsed.config.smsProvider,
      ...(deps.providerLog === undefined ? {} : { log: deps.providerLog }),
    })
  } catch {
    return notConfigured(['SMS_PROVIDER: refused for this ANAKLO_ENV'])
  }

  return {
    proxySecret: env.PROXY_SECRET,
    services: { rpc: deps.createRpc(supabaseUrl, serviceRoleKey), provider, config: parsed.config },
    log: deps.log,
  }
}

export function notConfiguredResponse(): Response {
  return errorResponse('not_configured', 'The booking functions are not configured.', 500)
}
