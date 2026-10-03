import { describe, expect, it } from 'vitest'
import { EMAIL_CONFIG_VARIABLES, EMAIL_PROVIDER_NAMES, parseEmailConfig } from './email-config.ts'

const LOCAL = { EMAIL_PROVIDER: 'fake', SUPPORT_EMAIL: 'support@example.com' }

describe('parseEmailConfig (contract 1.9 §3.3)', () => {
  it('reads exactly EMAIL_PROVIDER and SUPPORT_EMAIL; only fake exists in 1.9', () => {
    expect([...EMAIL_CONFIG_VARIABLES]).toEqual(['EMAIL_PROVIDER', 'SUPPORT_EMAIL'])
    expect([...EMAIL_PROVIDER_NAMES]).toEqual(['fake'])
  })

  it('accepts the local values in local and dev, lower-casing the support address', () => {
    expect(parseEmailConfig(LOCAL, 'local')).toEqual({
      ok: true,
      config: { provider: 'fake', supportEmail: 'support@example.com' },
    })
    expect(
      parseEmailConfig({ EMAIL_PROVIDER: ' fake ', SUPPORT_EMAIL: ' Support@Nous.GR ' }, 'dev'),
    ).toEqual({ ok: true, config: { provider: 'fake', supportEmail: 'support@nous.gr' } })
  })

  it('requires both, treating empty and env(NAME) as unset', () => {
    for (const raw of [{}, { EMAIL_PROVIDER: '', SUPPORT_EMAIL: '  ' }]) {
      expect(parseEmailConfig(raw, 'local')).toEqual({
        ok: false,
        problems: [
          'EMAIL_PROVIDER: required (fake)',
          'SUPPORT_EMAIL: required (the Nous address named in security emails)',
        ],
      })
    }
    expect(
      parseEmailConfig(
        { EMAIL_PROVIDER: 'env(EMAIL_PROVIDER)', SUPPORT_EMAIL: 'env(SUPPORT_EMAIL)' },
        'local',
      ),
    ).toMatchObject({ ok: false })
  })

  it('refuses an unknown provider (resend joins in 1.10)', () => {
    for (const provider of ['resend', 'smtp', 'FAKE']) {
      expect(parseEmailConfig({ ...LOCAL, EMAIL_PROVIDER: provider }, 'local')).toEqual({
        ok: false,
        problems: ['EMAIL_PROVIDER: unknown (fake)'],
      })
    }
  })

  it('refuses fake and an @example.com address in prod (ANAKLO_ENV unset = prod)', () => {
    expect(parseEmailConfig(LOCAL, 'prod')).toEqual({
      ok: false,
      problems: [
        'EMAIL_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)',
        'SUPPORT_EMAIL: an @example.com address is refused when ANAKLO_ENV is prod',
      ],
    })
    const upper = parseEmailConfig({ ...LOCAL, SUPPORT_EMAIL: 'Support@EXAMPLE.com' }, 'prod')
    expect(upper.ok).toBe(false)
    if (!upper.ok) {
      expect(upper.problems).toContain(
        'SUPPORT_EMAIL: an @example.com address is refused when ANAKLO_ENV is prod',
      )
    }
    // dev accepts the placeholder (the real address arrives with 1.10).
    expect(parseEmailConfig(LOCAL, 'dev').ok).toBe(true)
  })

  it('refuses a support value that is not one address', () => {
    for (const bad of ['support', 'support@', 'a@b.gr, c@d.gr', 'support @nous.gr']) {
      expect(parseEmailConfig({ ...LOCAL, SUPPORT_EMAIL: bad }, 'local')).toEqual({
        ok: false,
        problems: ['SUPPORT_EMAIL: must be one email address'],
      })
    }
  })

  it('names variables and rules, never values', () => {
    const result = parseEmailConfig(
      { EMAIL_PROVIDER: 'secret-provider-value', SUPPORT_EMAIL: 'not-an-address-value' },
      'prod',
    )
    const out = JSON.stringify(result)
    expect(out).not.toContain('secret-provider-value')
    expect(out).not.toContain('not-an-address-value')
  })
})
