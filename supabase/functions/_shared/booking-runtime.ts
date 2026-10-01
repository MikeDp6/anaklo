import {
  BOOKING_CONFIG_VARIABLES,
  configValue,
  parseAnakloEnv,
  parseBookingConfig,
  type BookingConfig,
} from './booking-config.ts'
import type { Log, Rpc } from './booking-rpc.ts'
import { errorResponse } from './http.ts'
import type { OneSignalPushPayload } from './onesignal.ts'
import { PUSH_CONFIG_VARIABLES, parsePushConfig, type PushConfig } from './push-config.ts'
import { createPushProvider, type PushProvider, type PushProviderLog } from './push-provider.ts'
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
  // 1.5: the push sender of the immediate path (contract 1.5 §3.5).
  ...PUSH_CONFIG_VARIABLES,
] as const
export type BookingEnvName = (typeof BOOKING_ENV_NAMES)[number]
export type BookingEnv = Partial<Record<BookingEnvName, string | undefined>>

export type BookingServices = {
  readonly rpc: Rpc
  readonly provider: SmsProvider
  readonly pushProvider: PushProvider
  readonly config: BookingConfig
}

export type BookingRuntime = {
  readonly proxySecret: string | undefined
  /** null: the configuration is invalid and every request answers 500 `not_configured`. */
  readonly services: BookingServices | null
  readonly log: Log
}

/** What both the booking functions and `dispatch` pass in besides their environment. */
export type SenderDeps = {
  readonly createRpc: (supabaseUrl: string, serviceRoleKey: string) => Rpc
  readonly log: Log
  /** Where the fake SMS adapter prints texts with `ANAKLO_ENV=local` (default: console). */
  readonly providerLog?: SmsProviderLog
  /** Where the fake push sender prints its line with `ANAKLO_ENV=local` (default: console). */
  readonly pushLog?: PushProviderLog
  /** Vitest: every payload the fake push sender would have sent. */
  readonly pushRecord?: (payload: OneSignalPushPayload) => void
  /** The OneSignal sender's HTTP client (default: the global `fetch`). */
  readonly fetch?: typeof fetch
}

export type BuildBookingRuntimeDeps = SenderDeps

export type Senders = {
  readonly provider: SmsProvider
  readonly pushProvider: PushProvider
}

/** `parsePushConfig` against the environment's own `ANAKLO_ENV` (unset = prod). */
export function parsePushConfigOf(
  env: Partial<Record<'ANAKLO_ENV' | (typeof PUSH_CONFIG_VARIABLES)[number], string | undefined>>,
) {
  return parsePushConfig(env, parseAnakloEnv(env.ANAKLO_ENV))
}

/**
 * The SMS adapter and the push sender for parsed configurations, or the problems (names and
 * rules only). Shared by `buildBookingRuntime` and `buildDispatchRuntime`.
 */
export function buildSenders(
  config: BookingConfig,
  push: PushConfig,
  deps: SenderDeps,
): { ok: true; senders: Senders } | { ok: false; problems: string[] } {
  let provider: SmsProvider
  try {
    provider = createSmsProvider({
      env: config.env,
      provider: config.smsProvider,
      ...(deps.providerLog === undefined ? {} : { log: deps.providerLog }),
    })
  } catch {
    return { ok: false, problems: ['SMS_PROVIDER: refused for this ANAKLO_ENV'] }
  }

  let pushProvider: PushProvider
  try {
    pushProvider = createPushProvider({
      env: config.env,
      provider: push.provider,
      oneSignal: push.oneSignal,
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      ...(deps.pushLog === undefined ? {} : { log: deps.pushLog }),
      ...(deps.pushRecord === undefined ? {} : { record: deps.pushRecord }),
    })
  } catch {
    return { ok: false, problems: ['PUSH_PROVIDER: refused for this ANAKLO_ENV'] }
  }
  return { ok: true, senders: { provider, pushProvider } }
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
  const push = parsePushConfigOf(env)
  if (!push.ok) problems.push(...push.problems)
  if (!parsed.ok || !push.ok || supabaseUrl === null || serviceRoleKey === null) {
    return notConfigured(problems)
  }

  const senders = buildSenders(parsed.config, push.config, deps)
  if (!senders.ok) return notConfigured(senders.problems)

  return {
    proxySecret: env.PROXY_SECRET,
    services: {
      rpc: deps.createRpc(supabaseUrl, serviceRoleKey),
      ...senders.senders,
      config: parsed.config,
    },
    log: deps.log,
  }
}

export function notConfiguredResponse(): Response {
  return errorResponse('not_configured', 'The booking functions are not configured.', 500)
}
