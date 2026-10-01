import { configValue, type AnakloEnv } from './booking-config.ts'
import type { PushProviderName } from './push-provider.ts'

/**
 * Push configuration of `public-booking`, `manage` and `dispatch` (contract 1.5 §3.5). Pure
 * (ADR-0002 §3): each `index.ts` reads the variables from `Deno.env` and passes them in; it is
 * parsed once at start-up, and an invalid configuration answers 500 `not_configured` on every
 * request (never partly used).
 *
 * Problems name the variable and the rule, never the value.
 */

export const PUSH_PROVIDER_NAMES = [
  'fake',
  'onesignal',
] as const satisfies readonly PushProviderName[]

export const PUSH_CONFIG_VARIABLES = [
  'PUSH_PROVIDER',
  'ONESIGNAL_APP_ID',
  'ONESIGNAL_REST_API_KEY',
] as const
export type PushConfigVariable = (typeof PUSH_CONFIG_VARIABLES)[number]
export type PushConfigEnv = Partial<Record<PushConfigVariable, string | undefined>>

export type PushConfig = {
  readonly provider: PushProviderName
  /** Only with `onesignal`; never logged. */
  readonly oneSignal: { readonly appId: string; readonly restApiKey: string } | null
}

export type PushConfigResult = { ok: true; config: PushConfig } | { ok: false; problems: string[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isPushProviderName(value: string): value is PushProviderName {
  return (PUSH_PROVIDER_NAMES as readonly string[]).includes(value)
}

/** `env` is the parsed `ANAKLO_ENV` (unset or unknown = prod, `parseAnakloEnv`). */
export function parsePushConfig(raw: PushConfigEnv, env: AnakloEnv): PushConfigResult {
  const problems: string[] = []
  const provider = configValue(raw.PUSH_PROVIDER)
  if (provider === null) {
    problems.push(`PUSH_PROVIDER: required (${PUSH_PROVIDER_NAMES.join(' | ')})`)
  } else if (!isPushProviderName(provider)) {
    problems.push(`PUSH_PROVIDER: unknown (${PUSH_PROVIDER_NAMES.join(' | ')})`)
  } else if (provider === 'fake' && env === 'prod') {
    problems.push('PUSH_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)')
  }

  let oneSignal: PushConfig['oneSignal'] = null
  if (provider === 'onesignal') {
    const appId = configValue(raw.ONESIGNAL_APP_ID)
    const restApiKey = configValue(raw.ONESIGNAL_REST_API_KEY)
    if (appId === null) problems.push('ONESIGNAL_APP_ID: required when PUSH_PROVIDER is onesignal')
    else if (!UUID.test(appId)) problems.push('ONESIGNAL_APP_ID: must be a UUID')
    if (restApiKey === null) {
      problems.push('ONESIGNAL_REST_API_KEY: required when PUSH_PROVIDER is onesignal')
    }
    if (appId !== null && UUID.test(appId) && restApiKey !== null) {
      oneSignal = { appId, restApiKey }
    }
  }

  if (problems.length > 0 || provider === null || !isPushProviderName(provider)) {
    return { ok: false, problems }
  }
  return { ok: true, config: { provider, oneSignal } }
}
