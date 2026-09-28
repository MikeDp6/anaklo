// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SECRETS, planSecrets, redact, toDotenv, vaultUpsertSql } from './secrets-plan.mjs'

const PROXY = 'p'.repeat(48)
const PUBLISHABLE = 'sb_publishable_dev_example'
const HMAC = 'h'.repeat(43)
const context = { knownLocalValues: ['local-dev-proxy-secret-change-me'] }
const base = { PROXY_SECRET: PROXY, SUPABASE_DEV_PUBLISHABLE_KEY: PUBLISHABLE }

describe('planSecrets', () => {
  it('gives PROXY_SECRET the same value in the functions and the Worker', () => {
    const plan = planSecrets(base, context)
    expect(plan.problems).toEqual([])
    expect(plan.functions).toEqual([{ name: 'PROXY_SECRET', value: PROXY }])
    expect(plan.worker).toEqual([
      { name: 'PROXY_SECRET', value: PROXY },
      { name: 'SUPABASE_PUBLISHABLE_KEY', value: PUBLISHABLE },
    ])
    expect(plan.vault).toEqual([])
    expect(plan.skipped).toEqual([
      'ONESIGNAL_APP_ID',
      'ONESIGNAL_REST_API_KEY',
      'otp_hmac_key',
      'phone_hmac_key',
    ])
  })

  it('reports missing required values without echoing anything', () => {
    const plan = planSecrets({}, context)
    expect(plan.problems).toEqual([
      'PROXY_SECRET: missing (source: PROXY_SECRET)',
      'SUPABASE_PUBLISHABLE_KEY: missing (source: SUPABASE_DEV_PUBLISHABLE_KEY)',
    ])
  })

  it('refuses short, local/example, quoted or multi-line secrets and never includes the value', () => {
    for (const bad of ['short', 'local-dev-proxy-secret-change-me', `${PROXY}'x`, `${PROXY}\nx`]) {
      const plan = planSecrets(
        { PROXY_SECRET: bad, SUPABASE_DEV_PUBLISHABLE_KEY: PUBLISHABLE },
        context,
      )
      expect(plan.problems).toHaveLength(1)
      expect(plan.problems[0]).toMatch(/^PROXY_SECRET: /)
      expect(plan.problems[0]).not.toContain(bad)
      expect(plan.functions).toEqual([])
    }
  })

  it('refuses a secret key where the publishable key belongs', () => {
    const plan = planSecrets(
      { PROXY_SECRET: PROXY, SUPABASE_DEV_PUBLISHABLE_KEY: 'sb_secret_xyz' },
      context,
    )
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

  it('sends the HMAC keys of step 1.3 to Vault only, as a pair (plan 1.1, Day 3)', () => {
    const plan = planSecrets({ ...base, OTP_HMAC_KEY: HMAC, PHONE_HMAC_KEY: `p${HMAC}` }, context)
    expect(plan.problems).toEqual([])
    expect(plan.vault).toEqual([
      { name: 'otp_hmac_key', value: HMAC },
      { name: 'phone_hmac_key', value: `p${HMAC}` },
    ])
    expect(plan.functions.map((entry) => entry.name)).toEqual(['PROXY_SECRET'])
    expect(planSecrets({ ...base, OTP_HMAC_KEY: HMAC }, context).problems).toEqual([
      'OTP_HMAC_KEY and PHONE_HMAC_KEY must be set together',
    ])
    const weak = planSecrets({ ...base, OTP_HMAC_KEY: 'short', PHONE_HMAC_KEY: HMAC }, context)
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
    expect(vault.map((spec) => spec.name)).toEqual(['otp_hmac_key', 'phone_hmac_key'])
    for (const spec of vault) expect(spec.targets).toEqual(['vault'])
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
