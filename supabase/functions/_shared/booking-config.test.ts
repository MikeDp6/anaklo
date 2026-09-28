import { describe, expect, it } from 'vitest'
import {
  MAX_SITE_HOST_LENGTH,
  otpCodeFor,
  parseAnakloEnv,
  parseBookingConfig,
  type BookingConfigEnv,
  type BookingConfigVariable,
} from './booking-config.ts'

/** The values of `.env.example`. */
const LOCAL: BookingConfigEnv = {
  ANAKLO_ENV: 'local',
  SITE_HOST: 'localhost:5173',
  SMS_PROVIDER: 'fake',
  OTP_TEST_NUMBERS: '+306900000001,+306900000002,+306900000999',
  OTP_TEST_CODE: '424242',
  SMS_ALLOWED_RECIPIENTS: '',
}

function omit(env: BookingConfigEnv, ...names: BookingConfigVariable[]): BookingConfigEnv {
  const copy = { ...env }
  for (const name of names) delete copy[name]
  return copy
}

function problemsOf(raw: BookingConfigEnv): string[] {
  const result = parseBookingConfig(raw)
  return result.ok ? [] : result.problems
}

describe('parseBookingConfig', () => {
  it('accepts the local values of .env.example', () => {
    const result = parseBookingConfig(LOCAL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.env).toBe('local')
    expect(result.config.siteHost).toBe('localhost:5173')
    expect(result.config.smsDomain).toBe('localhost')
    expect(result.config.smsProvider).toBe('fake')
    expect([...result.config.otpTestNumbers]).toEqual([
      '+306900000001',
      '+306900000002',
      '+306900000999',
    ])
    expect(result.config.otpTestCode).toBe('424242')
    expect(result.config.allowedRecipients.size).toBe(0)
  })

  it('treats empty values and unresolved env(NAME) as unset', () => {
    const result = parseBookingConfig({
      ...LOCAL,
      OTP_TEST_NUMBERS: 'env(OTP_TEST_NUMBERS)',
      OTP_TEST_CODE: '  ',
      SMS_ALLOWED_RECIPIENTS: 'env(SMS_ALLOWED_RECIPIENTS)',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.otpTestNumbers.size).toBe(0)
    expect(result.config.otpTestCode).toBeNull()
    expect(result.config.allowedRecipients.size).toBe(0)
    expect(problemsOf({ ...LOCAL, SITE_HOST: 'env(SITE_HOST)' })).toEqual([
      'SITE_HOST: required (e.g. localhost:5173 or dev.anaklo.gr)',
    ])
  })

  it('falls back to prod when ANAKLO_ENV is unset, unresolved or unknown (fail-safe)', () => {
    for (const value of [undefined, '', 'env(ANAKLO_ENV)', 'LOCAL', 'development', 'staging']) {
      expect(parseAnakloEnv(value), String(value)).toBe('prod')
    }
    expect(parseAnakloEnv(' dev ')).toBe('dev')
  })

  it('refuses the fake provider in prod', () => {
    const withoutTestNumbers = omit(LOCAL, 'OTP_TEST_NUMBERS', 'OTP_TEST_CODE')
    expect(problemsOf({ ...withoutTestNumbers, ANAKLO_ENV: 'prod' })).toEqual([
      'SMS_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)',
    ])
  })

  it('refuses test numbers and a test code when ANAKLO_ENV is prod or unset', () => {
    for (const env of ['prod', undefined, 'env(ANAKLO_ENV)']) {
      const problems = problemsOf({ ...LOCAL, ANAKLO_ENV: env })
      expect(problems, String(env)).toContain(
        'OTP_TEST_NUMBERS / OTP_TEST_CODE: refused when ANAKLO_ENV is prod (or unset)',
      )
    }
    // A test code alone is refused too (it is only ever used with the numbers).
    const codeOnly = omit(LOCAL, 'OTP_TEST_NUMBERS')
    expect(problemsOf({ ...codeOnly, ANAKLO_ENV: 'prod' })).toContain(
      'OTP_TEST_NUMBERS / OTP_TEST_CODE: refused when ANAKLO_ENV is prod (or unset)',
    )
  })

  it('refuses a recipient allow-list in prod, and accepts it in dev', () => {
    expect(
      problemsOf({ ...LOCAL, ANAKLO_ENV: 'prod', SMS_ALLOWED_RECIPIENTS: '+306912345678' }),
    ).toContain('SMS_ALLOWED_RECIPIENTS: refused when ANAKLO_ENV is prod (or unset)')
    const dev = parseBookingConfig({
      ...LOCAL,
      ANAKLO_ENV: 'dev',
      SITE_HOST: 'dev.anaklo.gr',
      SMS_ALLOWED_RECIPIENTS: '+306912345678, +447700900123',
    })
    expect(dev.ok).toBe(true)
    if (!dev.ok) return
    expect([...dev.config.allowedRecipients]).toEqual(['+306912345678', '+447700900123'])
    expect(dev.config.smsDomain).toBe('dev.anaklo.gr')
  })

  it('needs the test numbers and the test code together, and well-formed', () => {
    expect(problemsOf(omit(LOCAL, 'OTP_TEST_CODE'))).toEqual([
      'OTP_TEST_NUMBERS and OTP_TEST_CODE: set both or neither',
    ])
    expect(problemsOf(omit(LOCAL, 'OTP_TEST_NUMBERS'))).toEqual([
      'OTP_TEST_NUMBERS and OTP_TEST_CODE: set both or neither',
    ])
    expect(problemsOf({ ...LOCAL, OTP_TEST_CODE: '4242' })).toEqual([
      'OTP_TEST_CODE: must be 6 digits',
    ])
    // Only +3069 mobiles: OTP is sent to nothing else (AN018).
    for (const bad of ['+302101234567', '6900000001', '+44 7700 900123']) {
      expect(problemsOf({ ...LOCAL, OTP_TEST_NUMBERS: bad }), bad).toEqual([
        'OTP_TEST_NUMBERS: every entry must be a +3069 mobile in E.164',
      ])
    }
    expect(problemsOf({ ...LOCAL, SMS_ALLOWED_RECIPIENTS: '6912345678' })).toEqual([
      'SMS_ALLOWED_RECIPIENTS: every entry must be E.164',
    ])
  })

  it('keeps SITE_HOST within the SMS link budget, without a scheme', () => {
    expect(problemsOf({ ...LOCAL, SITE_HOST: 'x'.repeat(MAX_SITE_HOST_LENGTH) })).toEqual([])
    expect(problemsOf({ ...LOCAL, SITE_HOST: 'x'.repeat(MAX_SITE_HOST_LENGTH + 1) })).toEqual([
      `SITE_HOST: at most ${MAX_SITE_HOST_LENGTH} characters (SMS link budget)`,
    ])
    for (const bad of ['http://localhost:5173', 'Dev.Anaklo.gr', 'localhost:5173/', 'a b']) {
      expect(problemsOf({ ...LOCAL, SITE_HOST: bad }), bad).toEqual([
        'SITE_HOST: must be a lower-case host with an optional port, without a scheme',
      ])
    }
  })

  it('needs a known provider', () => {
    expect(problemsOf({ ...LOCAL, SMS_PROVIDER: undefined })).toEqual([
      'SMS_PROVIDER: required (fake)',
    ])
    expect(problemsOf({ ...LOCAL, SMS_PROVIDER: 'twilio' })).toEqual([
      'SMS_PROVIDER: unknown (fake)',
    ])
  })

  it('never puts a value into a problem', () => {
    const secretLooking = 'sb_secret_should_not_leak'
    const problems = problemsOf({
      ANAKLO_ENV: 'prod',
      SITE_HOST: secretLooking,
      SMS_PROVIDER: secretLooking,
      OTP_TEST_NUMBERS: secretLooking,
      OTP_TEST_CODE: secretLooking,
      SMS_ALLOWED_RECIPIENTS: secretLooking,
    })
    expect(problems.length).toBeGreaterThan(0)
    for (const problem of problems) expect(problem).not.toContain(secretLooking)
  })
})

describe('otpCodeFor', () => {
  it('gives the fixed code only to the listed test numbers', () => {
    const result = parseBookingConfig(LOCAL)
    if (!result.ok) throw new Error('local config must parse')
    expect(otpCodeFor(result.config, '+306900000001')).toBe('424242')
    expect(otpCodeFor(result.config, '+306900000999')).toBe('424242')
    expect(otpCodeFor(result.config, '+306912345678')).toBeNull()
  })

  it('never gives it in prod, even to a config built by hand', () => {
    const result = parseBookingConfig(LOCAL)
    if (!result.ok) throw new Error('local config must parse')
    expect(otpCodeFor({ ...result.config, env: 'prod' }, '+306900000001')).toBeNull()
  })
})
