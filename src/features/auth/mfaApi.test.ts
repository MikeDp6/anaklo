import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  FunctionsHttpError,
} from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failureOf } from '@/shared/lib/rpcError'
import {
  authorizeFactorAdd,
  EnrollFailure,
  enrollTotp,
  fetchAuthState,
  listUnverifiedFactorIds,
  listVerifiedFactors,
  qrImageSource,
  removeFactor,
  stepUpVerify,
  unenrollUnverified,
  verifyTotp,
} from './mfaApi'

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  refreshSession: vi.fn(),
  mfa: {
    getAuthenticatorAssuranceLevel: vi.fn(),
    unenroll: vi.fn(),
    enroll: vi.fn(),
    challenge: vi.fn(),
    verify: vi.fn(),
  },
}))
const rpc = vi.hoisted(() => vi.fn())
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/shared/lib/supabase', () => ({
  supabase: { auth, rpc, functions: { invoke } },
}))

// Synthetic ids.
const USER = '00000000-0000-4000-8000-00000000a015'
const F1 = '6f9619ff-8b86-4011-b42d-00c04fc96401'
const F2 = '6f9619ff-8b86-4011-b42d-00c04fc96402'
const F3 = '6f9619ff-8b86-4011-b42d-00c04fc96403'
const CHALLENGE = '6f9619ff-8b86-4011-b42d-00c04fc964c1'

function factor(id: string, status: 'verified' | 'unverified', name: string, createdAt: string) {
  return {
    id,
    friendly_name: name,
    factor_type: 'totp',
    status,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

const FACTORS = [
  factor(F2, 'verified', 'Tablet', '2026-10-02T09:00:00Z'),
  factor(F1, 'verified', 'iPhone', '2026-10-01T09:00:00Z'),
  factor(F3, 'unverified', 'Συσκευή 3', '2026-10-02T10:00:00Z'),
]

function user(factors = FACTORS) {
  return { data: { user: { id: USER, factors } }, error: null }
}

beforeEach(() => {
  auth.getUser.mockResolvedValue(user())
  auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
    data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
    error: null,
  })
  auth.mfa.unenroll.mockResolvedValue({ data: { id: F3 }, error: null })
  auth.mfa.challenge.mockResolvedValue({ data: { id: CHALLENGE, type: 'totp' }, error: null })
  auth.mfa.verify.mockResolvedValue({ data: {}, error: null })
  auth.refreshSession.mockResolvedValue({ data: {}, error: null })
})

describe('fetchAuthState (contract 1.7 §6.3)', () => {
  it('level from the token, verified devices from GoTrue, oldest first', async () => {
    await expect(fetchAuthState()).resolves.toEqual({
      kind: 'active',
      aal: 'aal2',
      verifiedFactors: [
        { id: F1, friendlyName: 'iPhone', createdAt: '2026-10-01T09:00:00Z' },
        { id: F2, friendlyName: 'Tablet', createdAt: '2026-10-02T09:00:00Z' },
      ],
    })
  })

  it('no level (or aal1) is aal1', async () => {
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: null, nextLevel: null, currentAuthenticationMethods: [] },
      error: null,
    })
    await expect(fetchAuthState()).resolves.toMatchObject({ kind: 'active', aal: 'aal1' })
  })

  it.each([
    ['session_not_found', new AuthSessionMissingError()],
    ['401', new AuthApiError('unauthorized', 401, 'bad_jwt')],
    ['403', new AuthApiError('gone', 403, 'session_not_found')],
  ])('a revoked session (%s) is revoked', async (_, error) => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error })
    await expect(fetchAuthState()).resolves.toEqual({ kind: 'revoked' })
  })

  it('offline throws (the route shows its error and «Δοκίμασε ξανά»)', async () => {
    const offline = new AuthRetryableFetchError('Failed to fetch', 0)
    auth.getUser.mockResolvedValue({ data: { user: null }, error: offline })
    await expect(fetchAuthState()).rejects.toBe(offline)
  })
})

describe('factor lists', () => {
  it('verified and unverified are told apart', async () => {
    await expect(listVerifiedFactors()).resolves.toHaveLength(2)
    await expect(listUnverifiedFactorIds()).resolves.toEqual([F3])
  })

  it('an Auth failure becomes the failure the screens know', async () => {
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    })
    expect(failureOf(await listVerifiedFactors().catch((e: unknown) => e))).toEqual({
      kind: 'offline',
    })
    auth.getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() })
    expect(failureOf(await listVerifiedFactors().catch((e: unknown) => e))).toEqual({
      kind: 'unauthorized',
    })
  })
})

describe('unenrollUnverified', () => {
  it('removes an unverified factor', async () => {
    await unenrollUnverified(F3)
    expect(auth.mfa.unenroll).toHaveBeenCalledExactlyOnceWith({ factorId: F3 })
  })

  it('refuses a verified factor: those go only through manage-factors', async () => {
    await expect(unenrollUnverified(F1)).rejects.toThrow(/verified/)
    expect(auth.mfa.unenroll).not.toHaveBeenCalled()
  })

  it('a factor that is gone already is fine', async () => {
    await expect(
      unenrollUnverified('6f9619ff-8b86-4011-b42d-00c04fc96499'),
    ).resolves.toBeUndefined()
    expect(auth.mfa.unenroll).not.toHaveBeenCalled()
  })
})

describe('qrImageSource (no QR library, never markup)', () => {
  it('GoTrue raw SVG becomes a percent-encoded SVG data URI', () => {
    const src = qrImageSource('data:image/svg+xml;utf-8,<svg fill="#000"><rect/></svg>')
    expect(src).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/)
    expect(src).not.toContain('#')
    expect(src).not.toContain('<')
  })

  it('an already encoded or base64 SVG is kept', () => {
    expect(qrImageSource('data:image/svg+xml;base64,PHN2Zy8+')).toBe(
      'data:image/svg+xml;base64,PHN2Zy8+',
    )
    expect(qrImageSource('data:image/svg+xml,%3Csvg%2F%3E')).toBe('data:image/svg+xml,%3Csvg%2F%3E')
  })

  it.each([
    'data:image/png;base64,iVBORw0KGgo=',
    'https://example.com/qr.svg',
    'javascript:alert(1)',
    '<svg onload="alert(1)"></svg>',
    '',
  ])('anything else (%s) is not shown', (value) => {
    expect(qrImageSource(value)).toBeNull()
  })
})

describe('enrollTotp', () => {
  it('passes the name and the issuer; returns the QR as an image source', async () => {
    auth.mfa.enroll.mockResolvedValue({
      data: {
        id: F3,
        type: 'totp',
        totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'S3CR3T', uri: 'otpauth://x' },
      },
      error: null,
    })
    const enrolled = await enrollTotp('Συσκευή 2', 'Anaklo')
    expect(auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      friendlyName: 'Συσκευή 2',
      issuer: 'Anaklo',
    })
    expect(enrolled).toMatchObject({ factorId: F3, secret: 'S3CR3T', uri: 'otpauth://x' })
    expect(enrolled.qrDataUri).toMatch(/^data:image\/svg\+xml/)
  })

  it.each([
    ['name_taken', new AuthApiError('exists', 422, 'mfa_factor_name_conflict')],
    ['rate_limited', new AuthApiError('slow down', 429, 'over_request_rate_limit')],
    ['offline', new AuthRetryableFetchError('Failed to fetch', 0)],
    ['unknown', new AuthApiError('nope', 400, 'other')],
  ])('%s', async (reason, error) => {
    auth.mfa.enroll.mockResolvedValue({ data: null, error })
    const failure: unknown = await enrollTotp('x', 'Anaklo').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(EnrollFailure)
    expect((failure as EnrollFailure).reason).toBe(reason)
  })
})

describe('verifyTotp / stepUpVerify', () => {
  it('ok', async () => {
    await expect(verifyTotp(F1, '123456')).resolves.toEqual({ ok: true })
    expect(auth.mfa.challenge).toHaveBeenCalledWith({ factorId: F1 })
    expect(auth.mfa.verify).toHaveBeenCalledWith({
      factorId: F1,
      challengeId: CHALLENGE,
      code: '123456',
    })
  })

  it.each([
    ['invalid_code', new AuthApiError('Invalid TOTP code entered', 422, 'mfa_verification_failed')],
    ['rate_limited', new AuthApiError('slow down', 429, 'over_request_rate_limit')],
    ['offline', new AuthRetryableFetchError('Failed to fetch', 0)],
    ['unknown', new AuthApiError('nope', 400, 'mfa_factor_not_found')],
  ])('%s', async (reason, error) => {
    auth.mfa.verify.mockResolvedValue({ data: null, error })
    await expect(verifyTotp(F1, '000000')).resolves.toEqual({ ok: false, reason })
  })

  it('an expired challenge gets one new challenge', async () => {
    auth.mfa.verify
      .mockResolvedValueOnce({
        data: null,
        error: new AuthApiError('expired', 422, 'mfa_challenge_expired'),
      })
      .mockResolvedValueOnce({ data: {}, error: null })
    await expect(verifyTotp(F1, '123456')).resolves.toEqual({ ok: true })
    expect(auth.mfa.challenge).toHaveBeenCalledTimes(2)
    expect(auth.mfa.verify).toHaveBeenCalledTimes(2)
  })

  // supabase-js turns GoTrue's 500 (two factors challenged in the same instant) into
  // AuthRetryableFetchError with status 500.
  it.each([
    ['AuthRetryableFetchError', new AuthRetryableFetchError('Unexpected failure', 500)],
    ['AuthApiError', new AuthApiError('Unhandled server error', 500, 'unexpected_failure')],
  ])(
    'a challenge the server failed (5xx, %s) gets one new challenge; the code is checked once',
    async (_name, error) => {
      auth.mfa.challenge.mockResolvedValueOnce({ data: null, error })
      await expect(verifyTotp(F1, '123456')).resolves.toEqual({ ok: true })
      expect(auth.mfa.challenge).toHaveBeenCalledTimes(2)
      expect(auth.mfa.verify).toHaveBeenCalledOnce()
    },
  )

  it('a second failed challenge is final, and no code is sent', async () => {
    auth.mfa.challenge.mockResolvedValue({
      data: null,
      error: new AuthRetryableFetchError('Unexpected failure', 500),
    })
    await expect(verifyTotp(F1, '123456')).resolves.toEqual({ ok: false, reason: 'offline' })
    expect(auth.mfa.challenge).toHaveBeenCalledTimes(2)
    expect(auth.mfa.verify).not.toHaveBeenCalled()
  })

  it('a network failure (no answer) is not repeated', async () => {
    auth.mfa.challenge.mockResolvedValue({
      data: null,
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    })
    await expect(verifyTotp(F1, '123456')).resolves.toEqual({ ok: false, reason: 'offline' })
    expect(auth.mfa.challenge).toHaveBeenCalledOnce()
    expect(auth.mfa.verify).not.toHaveBeenCalled()
  })

  it('a refused challenge (4xx) is not repeated', async () => {
    auth.mfa.challenge.mockResolvedValue({
      data: null,
      error: new AuthApiError('slow down', 429, 'over_request_rate_limit'),
    })
    await expect(verifyTotp(F1, '123456')).resolves.toEqual({ ok: false, reason: 'rate_limited' })
    expect(auth.mfa.challenge).toHaveBeenCalledOnce()
    expect(auth.mfa.verify).not.toHaveBeenCalled()
  })

  it('the code sheet refreshes the session after a verified code only', async () => {
    await expect(stepUpVerify(F1, '123456')).resolves.toEqual({ ok: true })
    expect(auth.refreshSession).toHaveBeenCalledOnce()
    auth.refreshSession.mockClear()
    auth.mfa.verify.mockResolvedValue({
      data: null,
      error: new AuthApiError('bad', 422, 'mfa_verification_failed'),
    })
    await expect(stepUpVerify(F1, '000000')).resolves.toEqual({ ok: false, reason: 'invalid_code' })
    expect(auth.refreshSession).not.toHaveBeenCalled()
  })
})

describe('authorizeFactorAdd / removeFactor', () => {
  it('asks the server for the permission (add, no factor)', async () => {
    const grant = {
      grant_id: '0b0f6d0e-0000-4000-8000-000000000001',
      user_id: USER,
      action: 'add',
      factor_id: null,
      expires_at: '2026-10-02T09:10:00Z',
    }
    rpc.mockResolvedValue({ data: grant, error: null, status: 200 })
    await expect(authorizeFactorAdd()).resolves.toEqual(grant)
    expect(rpc).toHaveBeenCalledWith('authorize_factor_change', { p_action: 'add' })
  })

  it('a stale code is a stepUp failure (the sheet opens upstream)', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'code required', hint: 'fresh_totp_required' },
      status: 403,
    })
    expect(failureOf(await authorizeFactorAdd().catch((e: unknown) => e))).toEqual({
      kind: 'stepUp',
      hint: 'fresh_totp_required',
    })
  })

  it('removal goes through manage-factors, never mfa.unenroll', async () => {
    invoke.mockResolvedValue({ data: { removed: true, factor_id: F1 }, error: null })
    await removeFactor(F1)
    expect(invoke).toHaveBeenCalledWith('manage-factors', {
      body: { action: 'remove', factor_id: F1 },
      timeout: 15_000,
    })
    expect(auth.mfa.unenroll).not.toHaveBeenCalled()
  })

  it('a 403 with the hint is a stepUp failure', async () => {
    const response = new Response(
      JSON.stringify({ code: '42501', message: 'code required', hint: 'aal2_required' }),
      { status: 403 },
    )
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(response) })
    expect(failureOf(await removeFactor(F1).catch((e: unknown) => e))).toEqual({
      kind: 'stepUp',
      hint: 'aal2_required',
    })
  })
})

describe('mfa.unenroll is called only here (plan 1.7, contract §6.3)', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return sources(path)
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
    })
  }

  it('no other module of src/ calls it', () => {
    const root = join(process.cwd(), 'src')
    const callers = sources(root)
      .filter((path) => /mfa\s*\.\s*unenroll\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path).split(sep).join('/'))
    expect(callers).toEqual(['features/auth/mfaApi.ts'])
  })
})
