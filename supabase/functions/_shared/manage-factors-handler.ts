import { json } from './http.ts'
import {
  callAs,
  checkMemberRequest,
  functionError,
  internalError,
  rpcErrorResponse,
  serveMemberFunction,
  type FactorsAdminPort,
  type MemberFunctionDeps,
} from './member-functions.ts'
import {
  AuthorizeFactorResult,
  ManageFactorsBody,
  type ManageFactorsResult,
} from './member-schemas.ts'

/**
 * `POST /functions/v1/manage-factors` (contract 1.7 §3.3, ADR-0009 §21): the ONLY way the pro app
 * removes a verified device of the authenticator app (never `mfa.unenroll`). `verify_jwt = true`;
 * called directly with the user's JWT, never through `/api`. Body `{ action: 'remove', factor_id }`
 * and nothing else. Pure (ADR-0002 §3): `manage-factors/index.ts` builds the ports.
 *
 * 1. As the caller: `authorize_factor_change('remove', factor_id)`: their own verified factor,
 *    not the last one (AN027 → 403 `{ code: 'P0001', message: 'AN027', hint: 'last_factor' }`),
 *    a fresh code (`42501` + hint → 403, the pro app opens the code sheet and retries once). It
 *    writes the grant and the audit rows.
 * 2. Only then the service-role client: `auth.admin.mfa.deleteFactor`. A factor that is already
 *    gone (404) counts as removed; any other failure → 502, and the grant expires unused.
 */

/** `{ action, factor_id }` only. */
export const MANAGE_FACTORS_MAX_BODY_BYTES = 512

export function handleManageFactors(
  req: Request,
  deps: MemberFunctionDeps<FactorsAdminPort> | null,
): Promise<Response> {
  return serveMemberFunction(req, () => removeFactor(req, deps))
}

async function removeFactor(
  req: Request,
  maybeDeps: MemberFunctionDeps<FactorsAdminPort> | null,
): Promise<Response> {
  const checked = await checkMemberRequest(
    req,
    maybeDeps,
    ManageFactorsBody,
    MANAGE_FACTORS_MAX_BODY_BYTES,
  )
  if (!checked.ok) return checked.response
  const { jwt, body, deps } = checked
  const { log } = deps

  // 1. The permission, as the caller (freshness, ownership and the last device: all in SQL).
  const authorized = await callAs(deps.caller(jwt).rpc, 'authorize_factor_change', {
    p_action: 'remove',
    p_factor_id: body.factor_id,
  })
  if (authorized.error !== null) {
    log('remove_refused', {
      code: authorized.error.code ?? null,
      hint: authorized.error.hint ?? null,
    })
    return rpcErrorResponse(authorized.error)
  }
  const grant = AuthorizeFactorResult.safeParse(authorized.data)
  if (!grant.success || grant.data.action !== 'remove' || grant.data.factor_id !== body.factor_id) {
    log('remove_grant_invalid', {})
    return internalError()
  }

  // 2. Only now the service-role client.
  const deleted = await deps.createAdmin().deleteFactor(grant.data.user_id, body.factor_id)
  if (!deleted.ok && deleted.status !== 404) {
    log('factor_delete_failed', { status: deleted.status })
    return functionError(502, 'factor_delete_failed', 'The device could not be removed.')
  }

  log('factor_removed', { already_gone: !deleted.ok })
  const result: ManageFactorsResult = { removed: true, factor_id: body.factor_id }
  return json(result)
}
