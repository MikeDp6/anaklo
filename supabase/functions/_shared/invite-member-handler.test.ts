// @vitest-environment node
// Request/Response from Node (undici), the same Fetch API the Deno runtime provides.
//
// `invite-member` (contract 1.7 §3.2) against fakes of the ports: the SQL itself
// (can_manage_members, add_member, user_id_for_email) is tested by pgTAP 14_members_identity.
// What matters here is the order: every refusal of the caller's check answers BEFORE the
// service-role client exists (createAdmin is never called).
import { describe, expect, it, vi } from 'vitest'
import type { LogValue, Rpc, RpcResult } from './booking-rpc.ts'
import { handleInviteMember, INVITE_MEMBER_MAX_BODY_BYTES } from './invite-member-handler.ts'
import type {
  CallerPort,
  CreateUserOutcome,
  InviteAdminPort,
  MemberFunctionDeps,
} from './member-functions.ts'
import { FunctionErrorBody, InviteMemberResult } from './member-schemas.ts'

const BUSINESS = '00000000-0000-4000-8000-000000000001'
const OWNER = '00000000-0000-4000-8000-00000000a001'
const NEW_USER = '00000000-0000-4000-8000-00000000b001'
const STAFF = '00000000-0000-4000-8000-000000000101'
const JWT = 'header.payload.signature'

const ok = (data: unknown): RpcResult => ({ data, error: null })
const refuse = (code: string, message: string, hint: string | null): RpcResult => ({
  data: null,
  error: { code, message, hint },
})

type Setup = {
  check?: RpcResult
  callerId?: string | null
  createUser?: CreateUserOutcome
  userIdForEmail?: RpcResult
  addMember?: RpcResult
}

function setup(options: Setup = {}) {
  const callerRpc = vi.fn<Rpc>(() => Promise.resolve(options.check ?? ok(true)))
  const caller = vi.fn<(jwt: string) => CallerPort>(() => ({
    rpc: callerRpc,
    userId: () => Promise.resolve(options.callerId === undefined ? OWNER : options.callerId),
  }))
  const adminRpc = vi.fn<Rpc>((fn) => {
    if (fn === 'user_id_for_email') return Promise.resolve(options.userIdForEmail ?? ok(NEW_USER))
    if (fn === 'add_member') {
      return Promise.resolve(
        options.addMember ??
          ok({
            business_id: BUSINESS,
            user_id: NEW_USER,
            role: 'staff',
            staff_id: STAFF,
            added: true,
          }),
      )
    }
    return Promise.resolve(refuse('PGRST202', 'unknown function', null))
  })
  const createUser = vi.fn<InviteAdminPort['createUser']>(() =>
    Promise.resolve(options.createUser ?? { ok: true, userId: NEW_USER }),
  )
  const createAdmin = vi.fn<() => InviteAdminPort>(() => ({ createUser, rpc: adminRpc }))
  const logs: Array<[string, Readonly<Record<string, LogValue>>]> = []
  const deps: MemberFunctionDeps<InviteAdminPort> = {
    caller,
    createAdmin,
    log: (event, fields) => logs.push([event, fields]),
  }
  return { deps, caller, callerRpc, createAdmin, createUser, adminRpc, logs }
}

const VALID_BODY = {
  business_id: BUSINESS,
  email: '  Nikos@Shop.GR ',
  role: 'staff',
  staff_id: STAFF,
}

function post(body: unknown = VALID_BODY, headers: HeadersInit = {}) {
  return new Request('http://kong:8000/functions/v1/invite-member', {
    method: 'POST',
    headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function errorOf(response: Response) {
  return FunctionErrorBody.parse(await response.json())
}

describe('invite-member: refusals before the service-role client', () => {
  it.each([
    ['an aal1 session', '42501', 'aal2_required'],
    ['a stale code', '42501', 'fresh_totp_required'],
  ])('passes %s through as 403 with the hint', async (_label, code, hint) => {
    const message = 'a code from the authenticator app is required'
    const { deps, createAdmin, callerRpc, caller } = setup({ check: refuse(code, message, hint) })
    const response = await handleInviteMember(post(), deps)
    expect(response.status).toBe(403)
    expect(await errorOf(response)).toEqual({ code: '42501', message, hint })
    expect(createAdmin).toHaveBeenCalledTimes(0)
    expect(caller).toHaveBeenCalledWith(JWT)
    expect(callerRpc).toHaveBeenCalledExactlyOnceWith('can_manage_members', {
      p_business_id: BUSINESS,
    })
  })

  it.each(['a manager', "another business's owner", 'a staff member'])(
    'refuses %s with 403 and no hint',
    async () => {
      const { deps, createAdmin } = setup({ check: refuse('42501', 'not allowed', null) })
      const response = await handleInviteMember(post(), deps)
      expect(response.status).toBe(403)
      expect(await errorOf(response)).toEqual({
        code: '42501',
        message: 'not allowed',
        hint: null,
      })
      expect(createAdmin).toHaveBeenCalledTimes(0)
    },
  )

  it('never trusts an answer other than true', async () => {
    const { deps, createAdmin } = setup({ check: ok(false) })
    const response = await handleInviteMember(post(), deps)
    expect(response.status).toBe(500)
    expect(createAdmin).toHaveBeenCalledTimes(0)
  })

  it('answers 401 when the session behind the JWT is gone', async () => {
    const { deps, createAdmin } = setup({ callerId: null })
    const response = await handleInviteMember(post(), deps)
    expect(response.status).toBe(401)
    expect(createAdmin).toHaveBeenCalledTimes(0)
  })

  it('refuses a request without a bearer token before any call', async () => {
    const { deps, caller, createAdmin } = setup()
    const request = new Request('http://kong:8000/functions/v1/invite-member', {
      method: 'POST',
      body: JSON.stringify(VALID_BODY),
    })
    const response = await handleInviteMember(request, deps)
    expect(response.status).toBe(401)
    expect((await errorOf(response)).code).toBe('unauthorized')
    expect(caller).not.toHaveBeenCalled()
    expect(createAdmin).not.toHaveBeenCalled()
  })

  it.each([
    ['not JSON', '{'],
    ['a bad email', { ...VALID_BODY, email: 'nikos' }],
    ['the owner role (D4)', { ...VALID_BODY, role: 'owner' }],
    ['a missing staff_id', { business_id: BUSINESS, email: 'a@b.gr', role: 'staff' }],
    ['an extra key', { ...VALID_BODY, user_id: OWNER }],
    ['a business id that is not one', { ...VALID_BODY, business_id: 'demo' }],
    ['an address over 254 characters', { ...VALID_BODY, email: `${'a'.repeat(250)}@b.gr` }],
  ])('answers 400 for %s, without any call', async (_label, body) => {
    const { deps, caller, createAdmin } = setup()
    const response = await handleInviteMember(post(body), deps)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('invalid_body')
    expect(caller).not.toHaveBeenCalled()
    expect(createAdmin).not.toHaveBeenCalled()
  })

  it('answers 413 above the body cap', async () => {
    const { deps, caller } = setup()
    const big = { ...VALID_BODY, email: 'x'.repeat(INVITE_MEMBER_MAX_BODY_BYTES) }
    const response = await handleInviteMember(post(big), deps)
    expect(response.status).toBe(413)
    expect(caller).not.toHaveBeenCalled()
  })

  it('answers 405 for another method, with Allow', async () => {
    const { deps } = setup()
    const request = new Request('http://kong:8000/functions/v1/invite-member', {
      headers: { Authorization: `Bearer ${JWT}` },
    })
    const response = await handleInviteMember(request, deps)
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('POST, OPTIONS')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('answers 500 not_configured when the environment is incomplete', async () => {
    const response = await handleInviteMember(post(), null)
    expect(response.status).toBe(500)
    expect((await errorOf(response)).code).toBe('not_configured')
  })

  it('answers the CORS preflight with 204, even unconfigured', async () => {
    const request = new Request('http://kong:8000/functions/v1/invite-member', {
      method: 'OPTIONS',
    })
    const response = await handleInviteMember(request, null)
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('authorization')
  })
})

describe('invite-member: after the check', () => {
  it('creates the user, adds the member as the caller, answers the result', async () => {
    const { deps, createUser, adminRpc, createAdmin, callerRpc } = setup()
    const response = await handleInviteMember(post(), deps)
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(InviteMemberResult.parse(await response.json())).toEqual({
      user_id: NEW_USER,
      email: 'nikos@shop.gr',
      role: 'staff',
      staff_id: STAFF,
      added: true,
      user_created: true,
    })
    expect(createAdmin).toHaveBeenCalledTimes(1)
    // The admin client came after the caller's check.
    expect(createAdmin.mock.invocationCallOrder[0]).toBeGreaterThan(
      callerRpc.mock.invocationCallOrder[0] ?? Infinity,
    )
    expect(createUser).toHaveBeenCalledExactlyOnceWith('nikos@shop.gr')
    expect(adminRpc).toHaveBeenCalledExactlyOnceWith('add_member', {
      p_business_id: BUSINESS,
      p_user_id: NEW_USER,
      p_role: 'staff',
      p_staff_id: STAFF,
      p_actor_id: OWNER,
    })
  })

  it('reuses an existing account (email_exists) through user_id_for_email', async () => {
    const { deps, adminRpc } = setup({
      createUser: { ok: false, exists: true, status: 422 },
      addMember: ok({
        business_id: BUSINESS,
        user_id: NEW_USER,
        role: 'manager',
        staff_id: null,
        added: false,
      }),
    })
    const response = await handleInviteMember(
      post({ ...VALID_BODY, role: 'manager', staff_id: null }),
      deps,
    )
    expect(response.status).toBe(200)
    expect(InviteMemberResult.parse(await response.json())).toMatchObject({
      user_id: NEW_USER,
      role: 'manager',
      added: false,
      user_created: false,
    })
    expect(adminRpc.mock.calls[0]).toEqual(['user_id_for_email', { p_email: 'nikos@shop.gr' }])
    expect(adminRpc.mock.calls[1]?.[0]).toBe('add_member')
  })

  it('answers 500 when an existing email has no account to reuse', async () => {
    const { deps, adminRpc } = setup({
      createUser: { ok: false, exists: true, status: 422 },
      userIdForEmail: ok(null),
    })
    const response = await handleInviteMember(post(), deps)
    expect(response.status).toBe(500)
    expect(adminRpc).toHaveBeenCalledTimes(1)
  })

  it('answers 502 when the account cannot be created, and adds nobody', async () => {
    const { deps, adminRpc } = setup({ createUser: { ok: false, exists: false, status: 500 } })
    const response = await handleInviteMember(post(), deps)
    expect(response.status).toBe(502)
    expect((await errorOf(response)).code).toBe('user_create_failed')
    expect(adminRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['AN028', 'already_member', 409],
    ['AN029', 'staff_has_login', 409],
  ])('passes %s of add_member through', async (code, hint, status) => {
    const { deps } = setup({ addMember: refuse('P0001', code, hint) })
    const response = await handleInviteMember(post(), deps)
    expect(response.status).toBe(status)
    expect(await errorOf(response)).toEqual({ code: 'P0001', message: code, hint })
  })

  it('answers 500 for an add_member result of another shape', async () => {
    const { deps } = setup({ addMember: ok({ added: true }) })
    expect((await handleInviteMember(post(), deps)).status).toBe(500)
  })

  it('logs codes only: never the email or the token', async () => {
    const { deps, logs } = setup({ check: refuse('42501', 'x', 'fresh_totp_required') })
    await handleInviteMember(post(), deps)
    const second = setup()
    await handleInviteMember(post(), second.deps)
    const text = JSON.stringify([...logs, ...second.logs])
    expect(text).not.toContain('nikos')
    expect(text).not.toContain(JWT)
    expect(logs).toEqual([['invite_refused', { code: '42501', hint: 'fresh_totp_required' }]])
  })
})
