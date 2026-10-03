// @vitest-environment node
//
// The 1.9 additions to `buildDispatchRuntime` (contract 1.9 §3.3, §3.6): the email sender, the
// support address and the Auth admin port. The 1.5 rules (secret, SMS, push) are tested in
// dispatch-handler.test.ts.
import { describe, expect, it } from 'vitest'
import type { LogValue, Rpc } from './booking-rpc.ts'
import { EMAIL_CONFIG_VARIABLES } from './email-config.ts'
import type { EmailSendRequest } from './email-provider.ts'
import {
  buildDispatchRuntime,
  DISPATCH_ENV_NAMES,
  LOCAL_DISPATCH_SECRET,
  type DispatchEnv,
} from './dispatch-runtime.ts'
import type { FactorsAdminPort } from './member-functions.ts'

const LOCAL_ENV: DispatchEnv = {
  SUPABASE_URL: 'http://kong:8000',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  DISPATCH_SECRET: LOCAL_DISPATCH_SECRET,
  ANAKLO_ENV: 'local',
  SITE_HOST: 'localhost:5173',
  SMS_PROVIDER: 'fake',
  SMS_ALLOWED_RECIPIENTS: '',
  PUSH_PROVIDER: 'fake',
  EMAIL_PROVIDER: 'fake',
  SUPPORT_EMAIL: 'Support@Example.com',
}

const rpc: Rpc = () => Promise.reject(new Error('no database in this test'))

function build(env: DispatchEnv, extra: { record?: (r: EmailSendRequest) => void } = {}) {
  const logs: Array<{ event: string; fields: Readonly<Record<string, LogValue>> }> = []
  const factorUrls: string[] = []
  const factors: FactorsAdminPort = { deleteFactor: () => Promise.resolve({ ok: true }) }
  const runtime = buildDispatchRuntime(env, {
    createRpc: () => rpc,
    createFactors: (url) => {
      factorUrls.push(url)
      return factors
    },
    log: (event, fields) => logs.push({ event, fields }),
    emailLog: () => {},
    ...(extra.record === undefined ? {} : { emailRecord: extra.record }),
  })
  const problems = logs.find((line) => line.event === 'not_configured')?.fields.problems
  return { runtime, factors, factorUrls, problems }
}

describe('buildDispatchRuntime: email and factors (contract 1.9 §3.3)', () => {
  it('reads EMAIL_PROVIDER and SUPPORT_EMAIL from the environment', () => {
    for (const name of EMAIL_CONFIG_VARIABLES) {
      expect(DISPATCH_ENV_NAMES as readonly string[]).toContain(name)
    }
  })

  it('builds the fake email sender, the lower-cased support address and the factors port', async () => {
    const recorded: EmailSendRequest[] = []
    const { runtime, factors, factorUrls } = build(LOCAL_ENV, {
      record: (request) => recorded.push(request),
    })
    expect(runtime.services?.emailProvider.name).toBe('fake')
    expect(runtime.services?.supportEmail).toBe('support@example.com')
    expect(runtime.services?.factors).toBe(factors)
    expect(factorUrls).toEqual(['http://kong:8000'])
    // emailRecord reaches the fake sender (Vitest's observation point).
    await runtime.services?.emailProvider.send({
      to: 'owner@demo-barber.test',
      subject: 's',
      text: 't',
      idempotencyKey: 'security:x:0',
    })
    expect(recorded.map((request) => request.to)).toEqual(['owner@demo-barber.test'])
  })

  it('answers not_configured (fail closed) without a valid email configuration', () => {
    const cases: Array<[DispatchEnv, string]> = [
      [{ ...LOCAL_ENV, EMAIL_PROVIDER: undefined }, 'EMAIL_PROVIDER: required (fake)'],
      [{ ...LOCAL_ENV, EMAIL_PROVIDER: 'resend' }, 'EMAIL_PROVIDER: unknown (fake)'],
      [
        { ...LOCAL_ENV, SUPPORT_EMAIL: undefined },
        'SUPPORT_EMAIL: required (the Nous address named in security emails)',
      ],
      [{ ...LOCAL_ENV, SUPPORT_EMAIL: 'nous' }, 'SUPPORT_EMAIL: must be one email address'],
      [{ ...LOCAL_ENV, EMAIL_PROVIDER: 'env(EMAIL_PROVIDER)' }, 'EMAIL_PROVIDER: required (fake)'],
    ]
    for (const [env, problem] of cases) {
      const { runtime, problems, factorUrls } = build(env)
      expect(runtime.services).toBeNull()
      expect(runtime.secret).toBeNull()
      expect(problems).toContain(problem)
      expect(factorUrls).toEqual([])
    }
  })

  it('refuses the fake email sender and the placeholder address in prod (ANAKLO_ENV unset)', () => {
    const { runtime, problems } = build({ ...LOCAL_ENV, ANAKLO_ENV: undefined })
    expect(runtime.services).toBeNull()
    expect(problems).toContain('EMAIL_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)')
    expect(problems).toContain(
      'SUPPORT_EMAIL: an @example.com address is refused when ANAKLO_ENV is prod',
    )
  })

  it('accepts fake in dev (the remote until the 1.10 sender exists)', () => {
    expect(build({ ...LOCAL_ENV, ANAKLO_ENV: 'dev' }).runtime.services?.emailProvider.name).toBe(
      'fake',
    )
  })

  it('names variables, never values', () => {
    const { problems } = build({ ...LOCAL_ENV, SUPPORT_EMAIL: 'not-an-address-value' })
    expect(JSON.stringify(problems)).not.toContain('not-an-address-value')
  })
})
