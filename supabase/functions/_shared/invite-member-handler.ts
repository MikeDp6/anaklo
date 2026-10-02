import { json } from './http.ts'
import {
  callAs,
  checkMemberRequest,
  functionError,
  internalError,
  rpcErrorResponse,
  serveMemberFunction,
  type InviteAdminPort,
  type MemberFunctionDeps,
} from './member-functions.ts'
import {
  AddMemberResult,
  InviteMemberBody,
  UserIdForEmailResult,
  type InviteMemberResult,
} from './member-schemas.ts'

/**
 * `POST /functions/v1/invite-member` (contract 1.7 §3.2, ADR-0009 §9): an owner adds a manager or
 * a staff member by email. `verify_jwt = true`; called by the pro app directly with the user's
 * JWT, never through `/api`. Pure (ADR-0002 §3): `invite-member/index.ts` builds the ports.
 *
 * 1. As the caller: `can_manage_members(p_business_id)` (owner + fresh code, in SQL). A refusal
 *    passes through: `42501` + `aal2_required`/`fresh_totp_required` → 403 with that hint (the
 *    pro app opens the code sheet and retries once); a manager or another business's owner → 403
 *    without a hint.
 * 2. Only then the service-role client: the Auth user (created confirmed, no invite link, or the
 *    existing one through `user_id_for_email`) and `add_member` with the caller as the actor.
 *
 * A user created in step 2 stays when `add_member` refuses: a retry finds them (`email_exists`).
 */

/** `{ business_id, email, role, staff_id }`: an address of ≤ 254 characters fits easily. */
export const INVITE_MEMBER_MAX_BODY_BYTES = 2048

export function handleInviteMember(
  req: Request,
  deps: MemberFunctionDeps<InviteAdminPort> | null,
): Promise<Response> {
  return serveMemberFunction(req, () => invite(req, deps))
}

async function invite(
  req: Request,
  maybeDeps: MemberFunctionDeps<InviteAdminPort> | null,
): Promise<Response> {
  const checked = await checkMemberRequest(
    req,
    maybeDeps,
    InviteMemberBody,
    INVITE_MEMBER_MAX_BODY_BYTES,
  )
  if (!checked.ok) return checked.response
  const { jwt, body, deps } = checked
  const { log } = deps

  // 1. The critical check, as the caller (rule 13: the freshness rule lives only in SQL).
  const caller = deps.caller(jwt)
  const allowed = await callAs(caller.rpc, 'can_manage_members', {
    p_business_id: body.business_id,
  })
  if (allowed.error !== null) {
    log('invite_refused', { code: allowed.error.code ?? null, hint: allowed.error.hint ?? null })
    return rpcErrorResponse(allowed.error)
  }
  if (allowed.data !== true) {
    log('invite_check_invalid', {})
    return internalError()
  }
  const callerId = await caller.userId()
  if (callerId === null) {
    return functionError(401, 'unauthorized', 'Invalid or expired session.')
  }

  // 2. Only now the service-role client (it bypasses RLS and the aal2 policies).
  const admin = deps.createAdmin()
  const user = await findOrCreateUser(admin, body.email, deps)
  if (!user.ok) return user.response

  const added = await callAs(admin.rpc, 'add_member', {
    p_business_id: body.business_id,
    p_user_id: user.userId,
    p_role: body.role,
    p_staff_id: body.staff_id,
    p_actor_id: callerId,
  })
  if (added.error !== null) {
    log('add_member_refused', { code: added.error.code ?? null, hint: added.error.hint ?? null })
    return rpcErrorResponse(added.error)
  }
  const member = AddMemberResult.safeParse(added.data)
  if (!member.success) {
    log('add_member_invalid_result', {})
    return internalError()
  }

  log('invite_done', { added: member.data.added, user_created: user.created })
  const result: InviteMemberResult = {
    user_id: member.data.user_id,
    email: body.email,
    role: member.data.role,
    staff_id: member.data.staff_id,
    added: member.data.added,
    user_created: user.created,
  }
  return json(result)
}

type FoundUser = { ok: true; userId: string; created: boolean } | { ok: false; response: Response }

async function findOrCreateUser(
  admin: InviteAdminPort,
  email: string,
  deps: MemberFunctionDeps<InviteAdminPort>,
): Promise<FoundUser> {
  const created = await admin.createUser(email)
  if (created.ok) return { ok: true, userId: created.userId, created: true }
  if (!created.exists) {
    deps.log('user_create_failed', { status: created.status })
    return {
      ok: false,
      response: functionError(502, 'user_create_failed', 'The account could not be created.'),
    }
  }

  const found = await callAs(admin.rpc, 'user_id_for_email', { p_email: email })
  const userId = found.error === null ? UserIdForEmailResult.safeParse(found.data) : null
  if (userId === null || !userId.success || userId.data === null) {
    deps.log('user_lookup_failed', { code: found.error?.code ?? null })
    return { ok: false, response: internalError() }
  }
  return { ok: true, userId: userId.data, created: false }
}
