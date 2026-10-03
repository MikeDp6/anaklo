// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  LOCAL_SEED_DISPATCH_SECRET,
  LOCAL_SEED_HMAC_KEYS,
  SECRETS,
  dispatchUrlFor,
  planSecrets,
  redact,
  toDotenv,
  vaultUpsertSql,
} from './secrets-plan.mjs'

const PROXY = 'p'.repeat(48)
const PUBLISHABLE = 'sb_publishable_dev_example'
const HMAC = 'h'.repeat(43)
const PHONE_HMAC = `p${HMAC}`
const DISPATCH = 'd'.repeat(43)
const REF = 'abcdefghijklmnopqrst'
const DISPATCH_URL = `https://${REF}.supabase.co/functions/v1/dispatch`
/** Synthetic: the real Nous address lives only in the env file outside the repo. */
const SUPPORT = 'support@nous-support.test'
const context = { knownLocalValues: ['local-dev-proxy-secret-change-me'], projectRef: REF }
const base = {
  PROXY_SECRET: PROXY,
  SUPABASE_DEV_PUBLISHABLE_KEY: PUBLISHABLE,
  OTP_HMAC_KEY: HMAC,
  PHONE_HMAC_KEY: PHONE_HMAC,
  PUSH_PROVIDER: 'fake',
  DISPATCH_SECRET: DISPATCH,
  DISPATCH_URL,
  EMAIL_PROVIDER: 'fake',
  SUPPORT_EMAIL: SUPPORT,
}
const BASE_FUNCTIONS = [
  { name: 'PROXY_SECRET', value: PROXY },
  { name: 'PUSH_PROVIDER', value: 'fake' },
  { name: 'DISPATCH_SECRET', value: DISPATCH },
  { name: 'EMAIL_PROVIDER', value: 'fake' },
  { name: 'SUPPORT_EMAIL', value: SUPPORT },
]
const BASE_VAULT = [
  { name: 'otp_hmac_key', value: HMAC },
  { name: 'phone_hmac_key', value: PHONE_HMAC },
  { name: 'dispatch_secret', value: DISPATCH },
  { name: 'dispatch_url', value: DISPATCH_URL },
]

describe('planSecrets', () => {
  it('gives PROXY_SECRET the same value in the functions and the Worker', () => {
    const plan = planSecrets(base, context)
    expect(plan.problems).toEqual([])
    expect(plan.functions).toEqual(BASE_FUNCTIONS)
    expect(plan.worker).toEqual([
      { name: 'PROXY_SECRET', value: PROXY },
      { name: 'SUPABASE_PUBLISHABLE_KEY', value: PUBLISHABLE },
    ])
    expect(plan.vault).toEqual(BASE_VAULT)
    expect(plan.skipped).toEqual(['ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY'])
  })

  it('reports missing required values without echoing anything', () => {
    const plan = planSecrets({}, context)
    expect(plan.problems).toEqual([
      'PROXY_SECRET: missing (source: PROXY_SECRET)',
      'SUPABASE_PUBLISHABLE_KEY: missing (source: SUPABASE_DEV_PUBLISHABLE_KEY)',
      'PUSH_PROVIDER: missing (source: PUSH_PROVIDER)',
      'DISPATCH_SECRET: missing (source: DISPATCH_SECRET)',
      'EMAIL_PROVIDER: missing (source: EMAIL_PROVIDER)',
      'SUPPORT_EMAIL: missing (source: SUPPORT_EMAIL)',
      'otp_hmac_key: missing (source: OTP_HMAC_KEY)',
      'phone_hmac_key: missing (source: PHONE_HMAC_KEY)',
      'dispatch_secret: missing (source: DISPATCH_SECRET)',
      'dispatch_url: missing (source: DISPATCH_URL)',
    ])
  })

  it('requires both HMAC keys of step 1.3 (contract 1.3 §9)', () => {
    const withoutKeys = { ...base, OTP_HMAC_KEY: undefined, PHONE_HMAC_KEY: '' }
    expect(planSecrets(withoutKeys, context).problems).toEqual([
      'otp_hmac_key: missing (source: OTP_HMAC_KEY)',
      'phone_hmac_key: missing (source: PHONE_HMAC_KEY)',
    ])
    const withoutPhone = { ...base, PHONE_HMAC_KEY: undefined }
    expect(planSecrets(withoutPhone, context).problems).toEqual([
      'phone_hmac_key: missing (source: PHONE_HMAC_KEY)',
    ])
  })

  it('refuses the local seed keys of supabase/seed.sql as remote keys, without echoing them', () => {
    const [seedOtp, seedPhone] = LOCAL_SEED_HMAC_KEYS
    const plan = planSecrets({ ...base, OTP_HMAC_KEY: seedOtp, PHONE_HMAC_KEY: seedPhone }, context)
    expect(plan.problems).toEqual([
      'otp_hmac_key: is the local seed value (supabase/seed.sql); generate a separate one for dev',
      'phone_hmac_key: is the local seed value (supabase/seed.sql); generate a separate one for dev',
    ])
    expect(plan.vault.map((entry) => entry.name)).toEqual(['dispatch_secret', 'dispatch_url'])
    for (const problem of plan.problems) {
      for (const key of LOCAL_SEED_HMAC_KEYS) expect(problem).not.toContain(key)
    }
  })

  it('refuses short, local/example, quoted or multi-line secrets and never includes the value', () => {
    for (const bad of ['short', 'local-dev-proxy-secret-change-me', `${PROXY}'x`, `${PROXY}\nx`]) {
      const plan = planSecrets({ ...base, PROXY_SECRET: bad }, context)
      expect(plan.problems).toHaveLength(1)
      expect(plan.problems[0]).toMatch(/^PROXY_SECRET: /)
      expect(plan.problems[0]).not.toContain(bad)
      expect(plan.functions.map((entry) => entry.name)).not.toContain('PROXY_SECRET')
      expect(plan.worker.map((entry) => entry.name)).not.toContain('PROXY_SECRET')
    }
  })

  it('refuses a secret key where the publishable key belongs', () => {
    const plan = planSecrets({ ...base, SUPABASE_DEV_PUBLISHABLE_KEY: 'sb_secret_xyz' }, context)
    expect(plan.problems).toEqual([
      'SUPABASE_PUBLISHABLE_KEY: expected the dev sb_publishable_ key',
    ])
    expect(plan.worker.map((entry) => entry.name)).toEqual(['PROXY_SECRET'])
  })

  it('sets the OneSignal app id and REST key together, for the functions only', () => {
    expect(planSecrets({ ...base, ONESIGNAL_APP_ID: 'app' }, context).problems).toEqual([
      'ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY must be set together',
    ])

    const plan = planSecrets(
      { ...base, VITE_ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'rest' },
      context,
    )
    expect(plan.problems).toEqual([])
    expect(plan.functions.map((entry) => entry.name)).toEqual([
      'PROXY_SECRET',
      'PUSH_PROVIDER',
      'DISPATCH_SECRET',
      'EMAIL_PROVIDER',
      'SUPPORT_EMAIL',
      'ONESIGNAL_APP_ID',
      'ONESIGNAL_REST_API_KEY',
    ])
    expect(plan.worker.map((entry) => entry.name)).not.toContain('ONESIGNAL_REST_API_KEY')
  })

  it('has no OneSignal identity key: pushes go to subscription ids (ADR-0010 §2)', () => {
    expect(SECRETS.map((spec) => spec.name)).not.toContain('ONESIGNAL_IDENTITY_KEY')
    const plan = planSecrets({ ...base }, context, ['ONESIGNAL_IDENTITY_KEY'])
    expect(plan.ignored).toEqual(['ONESIGNAL_IDENTITY_KEY'])
  })

  it('names unused entries of the env file, but not the known ones', () => {
    const plan = planSecrets(base, context, [
      'PROXY_SECRET',
      'CLOUDFLARE_API_TOKEN',
      'SUPABASE_SECRET_KEY',
      'OTP_HMAC_KEY',
      'RESEND_API_KEY',
    ])
    expect(plan.ignored).toEqual(['RESEND_API_KEY'])
  })

  it('sends the HMAC keys of step 1.3 to Vault only (plan 1.1, Day 3)', () => {
    const plan = planSecrets(base, context)
    expect(plan.problems).toEqual([])
    expect(plan.vault).toEqual(BASE_VAULT)
    expect(plan.functions.map((entry) => entry.name)).toEqual([
      'PROXY_SECRET',
      'PUSH_PROVIDER',
      'DISPATCH_SECRET',
      'EMAIL_PROVIDER',
      'SUPPORT_EMAIL',
    ])
    const weak = planSecrets({ ...base, OTP_HMAC_KEY: 'short' }, context)
    expect(weak.problems[0]).toMatch(/^otp_hmac_key: must be at least 32 characters/)
  })

  it('never sends a server key to the Worker', () => {
    const workerNames = SECRETS.filter((spec) => spec.targets.includes('worker')).map(
      (spec) => spec.name,
    )
    expect(workerNames).toEqual(['PROXY_SECRET', 'SUPABASE_PUBLISHABLE_KEY'])
  })

  it('has Vault entries only, and only with the snake_case names that SQL reads', () => {
    const vault = SECRETS.filter((spec) => spec.targets.includes('vault'))
    expect(vault.map((spec) => spec.name)).toEqual([
      'otp_hmac_key',
      'phone_hmac_key',
      'dispatch_secret',
      'dispatch_url',
    ])
    for (const spec of vault) expect(spec.targets).toEqual(['vault'])
  })
})

describe('planSecrets: messaging (contract 1.5 §3.5)', () => {
  it('gives DISPATCH_SECRET the same value in the functions and in Vault (dispatch_secret)', () => {
    const plan = planSecrets(base, context)
    expect(plan.functions).toContainEqual({ name: 'DISPATCH_SECRET', value: DISPATCH })
    expect(plan.vault).toContainEqual({ name: 'dispatch_secret', value: DISPATCH })
    expect(plan.worker.map((entry) => entry.name)).not.toContain('DISPATCH_SECRET')
  })

  it('refuses a short dispatch secret or the local seed value, without echoing it', () => {
    for (const bad of ['short-secret', LOCAL_SEED_DISPATCH_SECRET]) {
      const plan = planSecrets({ ...base, DISPATCH_SECRET: bad }, context)
      expect(plan.problems).toHaveLength(2)
      expect(plan.problems[0]).toMatch(/^DISPATCH_SECRET: /)
      expect(plan.problems[1]).toMatch(/^dispatch_secret: /)
      for (const problem of plan.problems) expect(problem).not.toContain(bad)
      expect(plan.vault.map((entry) => entry.name)).not.toContain('dispatch_secret')
    }
  })

  it("accepts only the dev project's own dispatch URL for Vault dispatch_url", () => {
    expect(dispatchUrlFor(REF)).toBe(DISPATCH_URL)
    for (const bad of [
      'http://kong:8000/functions/v1/dispatch',
      `http://${REF}.supabase.co/functions/v1/dispatch`,
      'https://zzzzzzzzzzzzzzzzzzzz.supabase.co/functions/v1/dispatch',
      `${DISPATCH_URL}/`,
    ]) {
      expect(planSecrets({ ...base, DISPATCH_URL: bad }, context).problems).toEqual([
        'dispatch_url: must be exactly https://<SUPABASE_DEV_PROJECT_REF>.supabase.co/functions/v1/dispatch',
      ])
    }
    expect(planSecrets(base, { knownLocalValues: context.knownLocalValues }).problems).toEqual([
      'dispatch_url: cannot be checked without the dev project ref',
    ])
  })

  it('takes PUSH_PROVIDER fake or onesignal; onesignal needs both OneSignal values', () => {
    expect(planSecrets({ ...base, PUSH_PROVIDER: 'vapid' }, context).problems).toEqual([
      'PUSH_PROVIDER: must be fake or onesignal',
    ])
    expect(planSecrets({ ...base, PUSH_PROVIDER: 'onesignal' }, context).problems).toEqual([
      'PUSH_PROVIDER: onesignal needs ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY',
    ])
    const withKeys = {
      ...base,
      PUSH_PROVIDER: 'onesignal',
      ONESIGNAL_APP_ID: 'app',
      ONESIGNAL_REST_API_KEY: 'rest',
    }
    const plan = planSecrets(withKeys, context)
    expect(plan.problems).toEqual([])
    expect(plan.functions).toContainEqual({ name: 'PUSH_PROVIDER', value: 'onesignal' })
  })
})

describe('planSecrets: security emails (contract 1.9 §3.6)', () => {
  it('sends EMAIL_PROVIDER and SUPPORT_EMAIL to the functions only', () => {
    const plan = planSecrets(base, context)
    expect(plan.problems).toEqual([])
    expect(plan.functions).toContainEqual({ name: 'EMAIL_PROVIDER', value: 'fake' })
    expect(plan.functions).toContainEqual({ name: 'SUPPORT_EMAIL', value: SUPPORT })
    expect(plan.worker.map((entry) => entry.name)).not.toContain('SUPPORT_EMAIL')
    expect(plan.vault.map((entry) => entry.name)).not.toContain('SUPPORT_EMAIL')
  })

  it('takes EMAIL_PROVIDER fake only until the Resend sender of 1.10', () => {
    for (const bad of ['resend', 'smtp', 'FAKE']) {
      expect(planSecrets({ ...base, EMAIL_PROVIDER: bad }, context).problems).toEqual([
        'EMAIL_PROVIDER: must be fake',
      ])
    }
  })

  it('refuses a support value that is not one address, or the @example.com placeholder', () => {
    for (const bad of ['nous', 'a@b', 'a b@nous.gr', 'a@b.gr,c@d.gr@x']) {
      const plan = planSecrets({ ...base, SUPPORT_EMAIL: bad }, context)
      expect(plan.problems).toEqual(['SUPPORT_EMAIL: must be one email address'])
      expect(plan.problems[0]).not.toContain(bad)
    }
    for (const placeholder of ['support@example.com', 'Support@Example.COM']) {
      expect(planSecrets({ ...base, SUPPORT_EMAIL: placeholder }, context).problems).toEqual([
        'SUPPORT_EMAIL: is the @example.com placeholder; use the real Nous address',
      ])
    }
  })

  it('still leaves RESEND_API_KEY and EMAIL_FROM unused until 1.10', () => {
    const plan = planSecrets(base, context, ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_PROVIDER'])
    expect(plan.ignored).toEqual(['RESEND_API_KEY', 'EMAIL_FROM'])
  })
})

describe('vaultUpsertSql', () => {
  it('creates or updates every secret by name, in one DO block', () => {
    const sql = vaultUpsertSql([
      { name: 'otp_hmac_key', value: HMAC },
      { name: 'phone_hmac_key', value: 'p+/=' },
    ])
    expect(sql.startsWith('do $$\n')).toBe(true)
    expect(sql.endsWith('end\n$$;\n')).toBe(true)
    expect(sql.match(/vault\.create_secret\(/g)).toHaveLength(2)
    expect(sql.match(/vault\.update_secret\(v_id, /g)).toHaveLength(2)
    expect(sql).toContain("where s.name = 'otp_hmac_key';")
    expect(sql).toContain(`perform vault.create_secret('${HMAC}', 'otp_hmac_key', `)
  })

  it('refuses a value that could leave the SQL string, without echoing it', () => {
    for (const unsafe of ["'", '$$', '\\', ' ', 'ά']) {
      const value = `secret${unsafe}value`
      expect(() => vaultUpsertSql([{ name: 'otp_hmac_key', value }])).toThrow(/^otp_hmac_key: /)
      expect(() => vaultUpsertSql([{ name: 'otp_hmac_key', value }])).not.toThrow(value)
    }
    expect(() => vaultUpsertSql([{ name: 'otp_hmac_key', value: '' }])).toThrow()
    expect(() => vaultUpsertSql([{ name: "x'; drop", value: HMAC }])).toThrow(/snake_case/)
  })
})

describe('redact', () => {
  it('hides every secret value in CLI output', () => {
    expect(redact(`LINE 5: perform vault.create_secret('${HMAC}'`, [HMAC, ''])).toBe(
      "LINE 5: perform vault.create_secret('[redacted]'",
    )
  })
})

describe('toDotenv', () => {
  it('single-quotes values so that $ and # are taken literally', () => {
    expect(
      toDotenv([
        { name: 'A', value: 'x$HOME#y' },
        { name: 'B', value: 'z' },
      ]),
    ).toBe("A='x$HOME#y'\nB='z'\n")
  })
})
