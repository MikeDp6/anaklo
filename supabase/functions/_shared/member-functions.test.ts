// @vitest-environment node
// Request/Response from Node (undici), the same Fetch API the Deno runtime provides.
import { describe, expect, it, vi } from 'vitest'
import type { Rpc } from './booking-rpc.ts'
import {
  bearerToken,
  callAs,
  callerPort,
  factorsAdminPort,
  functionError,
  inviteAdminPort,
  parseMemberFunctionEnv,
  readJsonBody,
  rpcErrorResponse,
  type AdminAuthLike,
  type UserAuthLike,
} from './member-functions.ts'
import { FunctionErrorBody, ManageFactorsBody } from './member-schemas.ts'

const USER = '00000000-0000-4000-8000-00000000a011'

async function body(response: Response) {
  return FunctionErrorBody.parse(await response.json())
}

describe('parseMemberFunctionEnv', () => {
  it('needs the three values the edge runtime injects', () => {
    expect(
      parseMemberFunctionEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_ANON_KEY: 'anon',
        SUPABASE_SERVICE_ROLE_KEY: 'service',
      }),
    ).toEqual({
      ok: true,
      config: { url: 'http://kong:8000', anonKey: 'anon', serviceRoleKey: 'service' },
    })
  })

  it('names what is missing, never a value (an unresolved env(...) counts as missing)', () => {
    const parsed = parseMemberFunctionEnv({
      SUPABASE_URL: 'http://kong:8000',
      SUPABASE_ANON_KEY: 'env(SUPABASE_ANON_KEY)',
    })
    expect(parsed).toEqual({
      ok: false,
      problems: ['SUPABASE_ANON_KEY: missing', 'SUPABASE_SERVICE_ROLE_KEY: missing'],
    })
  })
})

describe('rpcErrorResponse (D12: the PostgREST shape, flat)', () => {
  it.each([
    ['aal2_required', 'a code from the authenticator app is required'],
    ['fresh_totp_required', 'a code from the authenticator app is required'],
  ])('passes 42501 with the step-up hint %s through as 403', async (hint, message) => {
    const response = rpcErrorResponse({ code: '42501', message, hint })
    expect(response.status).toBe(403)
    expect(await body(response)).toEqual({ code: '42501', message, hint })
  })

  it('answers 42501 without a hint as 403 with hint null', async () => {
    const response = rpcErrorResponse({ code: '42501', message: 'not allowed', hint: null })
    expect(response.status).toBe(403)
    expect(await body(response)).toEqual({ code: '42501', message: 'not allowed', hint: null })
  })

  it('treats an empty hint as no hint', async () => {
    const response = rpcErrorResponse({ code: '42501', message: 'x', hint: '' })
    expect((await body(response)).hint).toBeNull()
  })

  it.each([
    ['AN027', 'last_factor', 403],
    ['AN028', 'already_member', 409],
    ['AN029', 'staff_has_login', 409],
    ['AN026', 'last_owner', 409],
    ['AN030', 'not_a_member', 404],
    ['AN031', 'member_elsewhere', 409],
  ])('passes the domain error %s through with its status', async (code, hint, status) => {
    const response = rpcErrorResponse({ code: 'P0001', message: code, hint })
    expect(response.status).toBe(status)
    expect(await body(response)).toEqual({ code: 'P0001', message: code, hint })
  })

  it.each(['22023', '22P02'])('answers %s as 400', (code) => {
    expect(rpcErrorResponse({ code, message: 'invalid', hint: null }).status).toBe(400)
  })

  it.each(['PGRST301', 'PGRST303'])('answers a refused JWT (%s) as 401', (code) => {
    expect(rpcErrorResponse({ code, message: 'JWT expired', hint: null }).status).toBe(401)
  })

  it.each([
    { code: 'P0001', message: 'something else', hint: null },
    { code: 'PGRST202', message: 'function not found', hint: 'Perhaps you meant …' },
    { code: null, message: 'TypeError: fetch failed', hint: null },
  ])('hides anything else behind 500 internal ($code)', async (error) => {
    const response = rpcErrorResponse(error)
    expect(response.status).toBe(500)
    expect(await body(response)).toEqual({
      code: 'internal',
      message: 'Internal error.',
      hint: null,
    })
  })

  it('sends JSON that no cache keeps', () => {
    const response = functionError(401, 'unauthorized', 'x')
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc', 'abc'],
    ['Basic abc', null],
    ['Bearer', null],
    ['Bearer a b', null],
  ])('%s → %s', (header, token) => {
    const req = new Request('http://x/', { headers: { Authorization: header } })
    expect(bearerToken(req)).toBe(token)
  })

  it('is null without the header', () => {
    expect(bearerToken(new Request('http://x/'))).toBeNull()
  })
})

describe('readJsonBody', () => {
  const post = (text: string) => new Request('http://x/', { method: 'POST', body: text })

  it('parses a body that matches', async () => {
    const read = await readJsonBody(
      post(JSON.stringify({ action: 'remove', factor_id: USER })),
      ManageFactorsBody,
      512,
    )
    expect(read).toEqual({ ok: true, data: { action: 'remove', factor_id: USER } })
  })

  it.each([
    ['not JSON', '{'],
    ['another shape', JSON.stringify({ action: 'add', factor_id: USER })],
    ['an extra key', JSON.stringify({ action: 'remove', factor_id: USER, user_id: USER })],
  ])('refuses %s with 400 invalid_body', async (_label, text) => {
    const read = await readJsonBody(post(text), ManageFactorsBody, 512)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.response.status).toBe(400)
    expect((await body(read.response)).code).toBe('invalid_body')
  })

  it('refuses a body over the cap with 413 without reading past it', async () => {
    const read = await readJsonBody(post('x'.repeat(513)), ManageFactorsBody, 512)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.response.status).toBe(413)
    expect((await body(read.response)).code).toBe('payload_too_large')
  })
})

describe('callAs', () => {
  it('turns a thrown call into an error without a SQLSTATE', async () => {
    const rpc = vi.fn<Rpc>(() => Promise.reject(new TypeError('fetch failed')))
    const result = await callAs(rpc, 'can_manage_members', { p_business_id: USER })
    expect(result.data).toBeNull()
    expect(result.error?.code).toBeNull()
    expect(rpcErrorResponse(result.error ?? {}).status).toBe(500)
  })
})

describe('ports over supabase-js', () => {
  const rpc: Rpc = () => Promise.resolve({ data: null, error: null })

  it('reads the caller id from getUser with their own JWT', async () => {
    const getUser = vi.fn<UserAuthLike['getUser']>(() =>
      Promise.resolve({ data: { user: { id: USER } }, error: null }),
    )
    expect(await callerPort({ getUser }, 'jwt-1', rpc).userId()).toBe(USER)
    expect(getUser).toHaveBeenCalledWith('jwt-1')
  })

  it('has no caller id for a revoked session or a failed call', async () => {
    const revoked: UserAuthLike = {
      getUser: () =>
        Promise.resolve({
          data: { user: null },
          error: { code: 'session_not_found', status: 403 },
        }),
    }
    const thrown: UserAuthLike = { getUser: () => Promise.reject(new Error('down')) }
    expect(await callerPort(revoked, 'jwt', rpc).userId()).toBeNull()
    expect(await callerPort(thrown, 'jwt', rpc).userId()).toBeNull()
  })

  it('creates a confirmed user without an invite link, a password or an email', async () => {
    const createUser = vi.fn<AdminAuthLike['createUser']>(() =>
      Promise.resolve({ data: { user: { id: USER } }, error: null }),
    )
    const port = inviteAdminPort({ createUser }, rpc)
    expect(await port.createUser('nikos@shop.gr')).toEqual({ ok: true, userId: USER })
    expect(createUser).toHaveBeenCalledExactlyOnceWith({
      email: 'nikos@shop.gr',
      email_confirm: true,
    })
  })

  it('reports an existing email (422 email_exists) apart from other failures', async () => {
    const answer = (code: string, status: number): AdminAuthLike['createUser'] =>
      vi.fn(() => Promise.resolve({ data: { user: null }, error: { code, status } }))
    expect(
      await inviteAdminPort({ createUser: answer('email_exists', 422) }, rpc).createUser('a@b.gr'),
    ).toEqual({ ok: false, exists: true, status: 422 })
    expect(
      await inviteAdminPort({ createUser: answer('over_request_rate_limit', 429) }, rpc).createUser(
        'a@b.gr',
      ),
    ).toEqual({ ok: false, exists: false, status: 429 })
  })

  it('deletes one factor of one user through the admin API', async () => {
    const deleteFactor = vi.fn<AdminAuthLike['mfa']['deleteFactor']>(() =>
      Promise.resolve({ error: null }),
    )
    const port = factorsAdminPort({ mfa: { deleteFactor } })
    expect(await port.deleteFactor(USER, 'f-1')).toEqual({ ok: true })
    expect(deleteFactor).toHaveBeenCalledExactlyOnceWith({ id: 'f-1', userId: USER })
  })

  it('reports the status of a failed deletion (404 = already gone, 0 = no answer)', async () => {
    const gone = factorsAdminPort({
      mfa: {
        deleteFactor: () =>
          Promise.resolve({ error: { code: 'mfa_factor_not_found', status: 404 } }),
      },
    })
    const down = factorsAdminPort({ mfa: { deleteFactor: () => Promise.reject(new Error('x')) } })
    expect(await gone.deleteFactor(USER, 'f-1')).toEqual({ ok: false, status: 404 })
    expect(await down.deleteFactor(USER, 'f-1')).toEqual({ ok: false, status: 0 })
  })
})
