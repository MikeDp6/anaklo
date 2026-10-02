// @vitest-environment node
// Request/Response from Node (undici), the same Fetch API the Deno runtime provides.
//
// `manage-factors` (contract 1.7 §3.3) against fakes of the ports: authorize_factor_change itself
// (freshness, own factor, last factor, grants and audit rows) is tested by pgTAP
// 14_members_identity. Here: every refusal answers BEFORE the service-role client exists.
import { describe, expect, it, vi } from 'vitest'
import type { Rpc, RpcResult } from './booking-rpc.ts'
import { handleManageFactors, MANAGE_FACTORS_MAX_BODY_BYTES } from './manage-factors-handler.ts'
import type {
  CallerPort,
  DeleteFactorOutcome,
  FactorsAdminPort,
  MemberFunctionDeps,
} from './member-functions.ts'
import { FunctionErrorBody, ManageFactorsResult } from './member-schemas.ts'

const USER = '00000000-0000-4000-8000-00000000a015'
const FACTOR = '00000000-0000-4000-8000-0000000f0001'
const OTHER_FACTOR = '00000000-0000-4000-8000-0000000f0002'
const GRANT = '00000000-0000-4000-8000-0000000a0001'
const JWT = 'header.payload.signature'

const ok = (data: unknown): RpcResult => ({ data, error: null })
const refuse = (code: string, message: string, hint: string | null): RpcResult => ({
  data: null,
  error: { code, message, hint },
})
const grant = (factorId = FACTOR) =>
  ok({
    grant_id: GRANT,
    user_id: USER,
    action: 'remove',
    factor_id: factorId,
    expires_at: '2026-10-02T10:10:00+00:00',
  })

function setup(authorized: RpcResult = grant(), deleted: DeleteFactorOutcome = { ok: true }) {
  const callerRpc = vi.fn<Rpc>(() => Promise.resolve(authorized))
  const caller = vi.fn<(jwt: string) => CallerPort>(() => ({
    rpc: callerRpc,
    userId: () => Promise.resolve(USER),
  }))
  const deleteFactor = vi.fn<FactorsAdminPort['deleteFactor']>(() => Promise.resolve(deleted))
  const createAdmin = vi.fn<() => FactorsAdminPort>(() => ({ deleteFactor }))
  const deps: MemberFunctionDeps<FactorsAdminPort> = { caller, createAdmin, log: () => undefined }
  return { deps, caller, callerRpc, createAdmin, deleteFactor }
}

function post(body: unknown = { action: 'remove', factor_id: FACTOR }) {
  return new Request('http://kong:8000/functions/v1/manage-factors', {
    method: 'POST',
    headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function errorOf(response: Response) {
  return FunctionErrorBody.parse(await response.json())
}

describe('manage-factors: refusals before the service-role client', () => {
  it.each(['aal2_required', 'fresh_totp_required'])(
    'answers 403 with the hint %s, so the pro app opens the code sheet',
    async (hint) => {
      const message = 'a code from the authenticator app is required'
      const { deps, createAdmin, callerRpc, caller } = setup(refuse('42501', message, hint))
      const response = await handleManageFactors(post(), deps)
      expect(response.status).toBe(403)
      expect(await errorOf(response)).toEqual({ code: '42501', message, hint })
      expect(createAdmin).toHaveBeenCalledTimes(0)
      expect(caller).toHaveBeenCalledWith(JWT)
      expect(callerRpc).toHaveBeenCalledExactlyOnceWith('authorize_factor_change', {
        p_action: 'remove',
        p_factor_id: FACTOR,
      })
    },
  )

  it('refuses the last device (AN027) with 403 and no step-up hint', async () => {
    const { deps, createAdmin } = setup(refuse('P0001', 'AN027', 'last_factor'))
    const response = await handleManageFactors(post(), deps)
    expect(response.status).toBe(403)
    expect(await errorOf(response)).toEqual({
      code: 'P0001',
      message: 'AN027',
      hint: 'last_factor',
    })
    expect(createAdmin).toHaveBeenCalledTimes(0)
  })

  it("refuses someone else's (or an unverified) factor with 403 and hint null", async () => {
    const { deps, createAdmin } = setup(refuse('42501', 'not your factor', null))
    const response = await handleManageFactors(post(), deps)
    expect(response.status).toBe(403)
    expect((await errorOf(response)).hint).toBeNull()
    expect(createAdmin).toHaveBeenCalledTimes(0)
  })

  it.each([
    ['action add', { action: 'add', factor_id: FACTOR }],
    ['action add without a factor', { action: 'add' }],
    ['an extra key', { action: 'remove', factor_id: FACTOR, user_id: USER }],
    ['a factor id that is not one', { action: 'remove', factor_id: 'f1' }],
    ['not JSON', 'remove'],
  ])('answers 400 for %s, without any call', async (_label, body) => {
    const { deps, caller, createAdmin } = setup()
    const response = await handleManageFactors(post(body), deps)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('invalid_body')
    expect(caller).not.toHaveBeenCalled()
    expect(createAdmin).not.toHaveBeenCalled()
  })

  it('answers 413 above the body cap', async () => {
    const { deps, caller } = setup()
    const body = {
      action: 'remove',
      factor_id: FACTOR,
      pad: 'x'.repeat(MANAGE_FACTORS_MAX_BODY_BYTES),
    }
    const response = await handleManageFactors(post(body), deps)
    expect(response.status).toBe(413)
    expect(caller).not.toHaveBeenCalled()
  })

  it('answers 401 without a bearer token', async () => {
    const { deps, caller } = setup()
    const request = new Request('http://kong:8000/functions/v1/manage-factors', {
      method: 'POST',
      body: JSON.stringify({ action: 'remove', factor_id: FACTOR }),
    })
    expect((await handleManageFactors(request, deps)).status).toBe(401)
    expect(caller).not.toHaveBeenCalled()
  })

  it('answers the CORS preflight with 204', async () => {
    const request = new Request('http://kong:8000/functions/v1/manage-factors', {
      method: 'OPTIONS',
    })
    const response = await handleManageFactors(request, setup().deps)
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS')
  })

  it.each([
    ['a result of another shape', ok({ grant_id: GRANT })],
    ['a grant for another factor', grant(OTHER_FACTOR)],
  ])('answers 500 for %s, and deletes nothing', async (_label, authorized) => {
    const { deps, createAdmin } = setup(authorized)
    expect((await handleManageFactors(post(), deps)).status).toBe(500)
    expect(createAdmin).not.toHaveBeenCalled()
  })
})

describe('manage-factors: after the grant', () => {
  it("deletes the factor of the grant's user through the admin API", async () => {
    const { deps, deleteFactor, createAdmin, callerRpc } = setup()
    const response = await handleManageFactors(post(), deps)
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(ManageFactorsResult.parse(await response.json())).toEqual({
      removed: true,
      factor_id: FACTOR,
    })
    expect(createAdmin).toHaveBeenCalledTimes(1)
    expect(createAdmin.mock.invocationCallOrder[0]).toBeGreaterThan(
      callerRpc.mock.invocationCallOrder[0] ?? Infinity,
    )
    expect(deleteFactor).toHaveBeenCalledExactlyOnceWith(USER, FACTOR)
  })

  it('takes an upper-case factor id as the same factor (Postgres answers uuids lower-case)', async () => {
    // A grant committed and then a 500 would leave an open `remove` grant that, for 10′, makes the
    // user's other device count as the last one (D11).
    const upper = 'ABCDEF01-2345-4678-89AB-CDEF01234567'
    const lower = upper.toLowerCase()
    const { deps, callerRpc, deleteFactor } = setup(grant(lower))
    const response = await handleManageFactors(post({ action: 'remove', factor_id: upper }), deps)
    expect(response.status).toBe(200)
    expect(ManageFactorsResult.parse(await response.json())).toEqual({
      removed: true,
      factor_id: lower,
    })
    expect(callerRpc).toHaveBeenCalledExactlyOnceWith('authorize_factor_change', {
      p_action: 'remove',
      p_factor_id: lower,
    })
    expect(deleteFactor).toHaveBeenCalledExactlyOnceWith(USER, lower)
  })

  it('counts a factor that is already gone (404) as removed', async () => {
    const { deps } = setup(grant(), { ok: false, status: 404 })
    const response = await handleManageFactors(post(), deps)
    expect(response.status).toBe(200)
    expect(ManageFactorsResult.parse(await response.json()).removed).toBe(true)
  })

  it.each([500, 0])('answers 502 when the deletion fails (%s)', async (status) => {
    const { deps } = setup(grant(), { ok: false, status })
    const response = await handleManageFactors(post(), deps)
    expect(response.status).toBe(502)
    expect((await errorOf(response)).code).toBe('factor_delete_failed')
  })
})
