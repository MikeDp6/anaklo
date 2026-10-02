import { InviteMemberResult } from '@fn-shared/member-schemas.ts'
import { writeSignal } from '@/features/calendar/api'
import type { Database } from '@/shared/lib/database.types'
import { throwIfFunctionFailed } from '@/shared/lib/functionError'
import { throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import {
  MemberRows,
  RemoveResponse,
  SetRoleResponse,
  toMembers,
  type InviteBody,
  type InviteResult,
  type Member,
  type RemoveResult,
  type RoleChange,
  type SetRoleResult,
} from './schema'

/**
 * Data access of «Μέλη» (contract 1.7 §6.8). Components never import supabase-js (rule 2). Every
 * answer is parsed (zod/mini); failures are thrown as `RpcFailure` (a function's non-2xx answer
 * too, through `throwIfFunctionFailed`, so a step-up hint reaches `withStepUp`). Writes give up
 * after 15″ (the outcome is then unknown and the sheet offers the identical retry; every write
 * here is idempotent, D9).
 */

type Functions = Database['public']['Functions']
type Args<Name extends keyof Functions> = Functions[Name]['Args']

/** Everyone with a login to the business, with their email (owner only; no fresh code). */
export async function fetchMembers(businessId: string, signal?: AbortSignal): Promise<Member[]> {
  const args: Args<'list_members'> = { p_business_id: businessId }
  let call = supabase.rpc('list_members', args)
  if (signal) call = call.abortSignal(signal)
  const { data, error, status } = await call
  throwIfFailed(error, status)
  return toMembers(MemberRows.parse(data))
}

/**
 * `invite-member` (contract 1.7 §3.2): creates the login if needed (no email is sent) and adds the
 * membership. The Edge Function checks the owner and the fresh code before anything else.
 */
export async function inviteMember(body: InviteBody): Promise<InviteResult> {
  const response = await supabase.functions.invoke<unknown>('invite-member', {
    body,
    signal: writeSignal(),
  })
  // functions-js types a failure as `any`; it is classified, never read as is.
  const error: unknown = response.error
  if (error) await throwIfFunctionFailed(error)
  return InviteMemberResult.parse(response.data)
}

export async function setMemberRole(
  businessId: string,
  change: RoleChange,
): Promise<SetRoleResult> {
  const args: Args<'set_member_role'> = {
    p_business_id: businessId,
    p_user_id: change.userId,
    p_role: change.role,
  }
  const { data, error, status } = await supabase
    .rpc('set_member_role', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return SetRoleResponse.parse(data)
}

export async function removeMember(businessId: string, userId: string): Promise<RemoveResult> {
  const args: Args<'remove_member'> = { p_business_id: businessId, p_user_id: userId }
  const { data, error, status } = await supabase
    .rpc('remove_member', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return RemoveResponse.parse(data)
}
