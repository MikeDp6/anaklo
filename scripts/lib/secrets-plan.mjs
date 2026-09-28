// Which dev secret goes where (plan 1.1, ADR-0008 §1), and the checks on the values. Pure; the
// values are only ever compared and handed to the CLIs, never printed. Vitest: secrets-plan.test.mjs.
import { TOOL_TOKENS } from './cli.mjs'

/** @typedef {'functions' | 'worker' | 'vault'} SecretTarget */

/**
 * @typedef {object} SecretSpec
 * @property {string} name the name the function/Worker reads, or the Vault secret's name
 * @property {readonly string[]} from source names, first non-empty wins
 * @property {readonly SecretTarget[]} targets
 * @property {boolean} required
 * @property {(value: string, context: PlanContext) => string | null} [check] problem or null
 */

/**
 * @typedef {object} PlanContext
 * @property {readonly string[]} knownLocalValues local/example secrets that must never go remote
 */

const MIN_PROXY_SECRET = 32

/** HMAC keys: at least 32 characters of base64, base64url or hex (e.g. 32 random bytes). */
const HMAC_KEY = /^[A-Za-z0-9+/_=-]{32,}$/

/** @param {string} value */
const hmacKeyCheck = (value) =>
  HMAC_KEY.test(value)
    ? null
    : 'must be at least 32 characters of base64 or hex (generate one, e.g. 32 random bytes)'

/** @type {readonly SecretSpec[]} */
export const SECRETS = [
  {
    // Same value in the Worker (adds the header) and the functions (check it, _shared/http.ts).
    name: 'PROXY_SECRET',
    from: ['PROXY_SECRET'],
    targets: ['functions', 'worker'],
    required: true,
    check: (value, context) => {
      if (value.length < MIN_PROXY_SECRET) {
        return `must be at least ${MIN_PROXY_SECRET} characters (generate one, e.g. 48 random bytes in base64)`
      }
      if (context.knownLocalValues.includes(value)) {
        return 'is the local/example value; generate a separate one for dev'
      }
      return null
    },
  },
  {
    // The proxy sends it as `apikey` (edge/api-proxy.ts). Public by design, but kept out of
    // wrangler.jsonc so that the dev and prod Workers differ only in secrets.
    name: 'SUPABASE_PUBLISHABLE_KEY',
    from: ['SUPABASE_DEV_PUBLISHABLE_KEY'],
    targets: ['worker'],
    required: true,
    check: (value) =>
      value.startsWith('sb_publishable_') ? null : 'expected the dev sb_publishable_ key',
  },
  {
    // spike-push (ADR-0010 §3), later dispatch. Optional until the push test; the app id and the
    // REST key go together. No identity key: pushes go to subscription ids (ADR-0010 §2).
    name: 'ONESIGNAL_APP_ID',
    from: ['ONESIGNAL_APP_ID', 'VITE_ONESIGNAL_APP_ID'],
    targets: ['functions'],
    required: false,
  },
  {
    name: 'ONESIGNAL_REST_API_KEY',
    from: ['ONESIGNAL_REST_API_KEY'],
    targets: ['functions'],
    required: false,
  },
  {
    // Vault (read by SQL, never by the functions): the OTP code HMAC of 0005 (step 1.3).
    // Optional until 1.3 makes it required.
    name: 'otp_hmac_key',
    from: ['OTP_HMAC_KEY'],
    targets: ['vault'],
    required: false,
    check: hmacKeyCheck,
  },
  {
    // Vault: private.phone_hmac() of 0005 (suppression list, rate-limit keys; step 1.3).
    name: 'phone_hmac_key',
    from: ['PHONE_HMAC_KEY'],
    targets: ['vault'],
    required: false,
    check: hmacKeyCheck,
  },
  // 1.5a adds the dispatch URL and its secret (pg_net) here, with target 'vault'.
]

/** Names an env file may hold for the other dev scripts; not reported as unused. */
const OTHER_KNOWN = [...TOOL_TOKENS, 'SUPABASE_DEV_PROJECT_REF', 'SUPABASE_SECRET_KEY']

/** Groups whose members must be set together. */
const TOGETHER = [
  ['ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY'],
  ['otp_hmac_key', 'phone_hmac_key'],
]

/**
 * @typedef {object} SecretPlan
 * @property {Array<{ name: string, value: string }>} functions
 * @property {Array<{ name: string, value: string }>} worker
 * @property {Array<{ name: string, value: string }>} vault
 * @property {string[]} skipped optional names without a value
 * @property {string[]} problems
 * @property {string[]} ignored names in the env file that nothing uses (yet)
 */

/**
 * @param {Record<string, string | undefined>} values merged sources (env file over process env)
 * @param {PlanContext} context
 * @param {readonly string[]} [fileNames] names present in the env file, to report unused ones
 * @returns {SecretPlan}
 */
export function planSecrets(values, context, fileNames = []) {
  /** @type {SecretPlan} */
  const plan = { functions: [], worker: [], vault: [], skipped: [], problems: [], ignored: [] }
  /** @type {Set<string>} */
  const present = new Set()
  for (const spec of SECRETS) {
    const value = spec.from.map((name) => values[name]?.trim()).find(Boolean)
    if (!value) {
      if (spec.required)
        plan.problems.push(`${spec.name}: missing (source: ${spec.from.join(' or ')})`)
      else plan.skipped.push(spec.name)
      continue
    }
    // Values go to `supabase secrets set --env-file` single-quoted (literal) and to wrangler on
    // stdin: no quotes or line breaks, so nothing can be reinterpreted.
    if (/['\r\n]/.test(value)) {
      plan.problems.push(`${spec.name}: must not contain quotes or line breaks`)
      continue
    }
    const problem = spec.check?.(value, context)
    if (problem) {
      plan.problems.push(`${spec.name}: ${problem}`)
      continue
    }
    present.add(spec.name)
    for (const target of spec.targets) plan[target].push({ name: spec.name, value })
  }
  for (const group of TOGETHER) {
    const set = group.filter((name) => present.has(name))
    if (set.length > 0 && set.length < group.length) {
      const names = group.map((name) => SECRETS.find((spec) => spec.name === name)?.from[0] ?? name)
      plan.problems.push(`${names.join(' and ')} must be set together`)
    }
  }
  const used = new Set([...SECRETS.flatMap((spec) => spec.from), ...OTHER_KNOWN])
  plan.ignored = fileNames.filter((name) => !used.has(name))
  return plan
}

/**
 * A dotenv file for `supabase secrets set --env-file`: single-quoted values are taken literally
 * (no escapes, no $VAR expansion). planSecrets already rejected quotes and line breaks.
 * @param {ReadonlyArray<{ name: string, value: string }>} entries
 */
export function toDotenv(entries) {
  return entries.map(({ name, value }) => `${name}='${value}'`).join('\n') + '\n'
}

const VAULT_NAME = /^[a-z][a-z0-9_]{0,62}$/
/** Printable ASCII (no space) without quote, backslash or dollar: safe inside '…' in a $$ block. */
const VAULT_VALUE = /^[!-~]+$/
const VAULT_UNSAFE = /['\\$]/
const VAULT_DESCRIPTION = 'npm run secrets:dev'

/**
 * ONE statement that creates or updates each Vault secret by name, all or nothing, for
 * `supabase db query --linked --file <private temp file>`: the values never go on a command line.
 * `vault.update_secret` when the name exists, else `vault.create_secret`. Refuses (without
 * echoing the value) anything that could break out of the SQL string.
 * @param {ReadonlyArray<{ name: string, value: string }>} entries
 * @returns {string}
 */
export function vaultUpsertSql(entries) {
  const steps = entries.map(({ name, value }) => {
    if (!VAULT_NAME.test(name)) throw new Error(`Vault name "${name}" must be snake_case`)
    if (!VAULT_VALUE.test(value) || VAULT_UNSAFE.test(value)) {
      throw new Error(`${name}: the value must be printable ASCII without quotes, \\ or $`)
    }
    return [
      `  select s.id into v_id from vault.secrets s where s.name = '${name}';`,
      '  if v_id is null then',
      `    perform vault.create_secret('${value}', '${name}', '${VAULT_DESCRIPTION}');`,
      '  else',
      `    perform vault.update_secret(v_id, '${value}', '${name}', '${VAULT_DESCRIPTION}');`,
      '  end if;',
    ].join('\n')
  })
  return ['do $$', 'declare', '  v_id uuid;', 'begin', ...steps, 'end', '$$;', ''].join('\n')
}

/**
 * Replaces every secret value in a CLI's output before it is printed (an SQL error may quote
 * the statement).
 * @param {string} text
 * @param {readonly string[]} values
 */
export function redact(text, values) {
  return values
    .filter((value) => value.length > 0)
    .reduce((out, value) => out.split(value).join('[redacted]'), text)
}
