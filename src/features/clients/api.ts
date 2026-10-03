import { writeSignal } from '@/features/calendar/api'
import type { Database } from '@/shared/lib/database.types'
import { RpcFailure, throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import {
  ClientHitRows,
  STAFF_CONSENT_NOTICE_VERSION,
  toClientCard,
  toEraseResult,
  toSetConsentResult,
  type ClientCard,
  type ClientHit,
  type ConsentInput,
  type DetailsInput,
  type EraseResult,
  type NoteInput,
  type SetConsentResult,
} from './schema'

/**
 * Data access of the client feature (contracts 1.4 §2.6.7, 1.8 §3.1): the only Supabase access
 * of `features/clients`. Every answer is parsed (zod/mini), every failure is thrown as an
 * `RpcFailure`, and every write gives up after 15″ (its outcome is then unknown: the form locks
 * and offers the identical retry, which is idempotent for each write here). No merge in Phase 1
 * (contract 1.8 D2: the screen comes with the importer).
 */

type Functions = Database['public']['Functions']
type Args<Name extends keyof Functions> = Functions[Name]['Args']

/**
 * Client search of the quick add and of «Πελάτες»: name in Greek, Greeklish or capitals, or the
 * last digits of the phone (contract 1.4 §2.6.7).
 */
export async function searchClients(
  businessId: string,
  query: string,
  signal?: AbortSignal,
): Promise<ClientHit[]> {
  const args: Args<'search_clients'> = { p_business_id: businessId, p_query: query }
  let call = supabase.rpc('search_clients', args)
  if (signal) call = call.abortSignal(signal)
  const { data, error, status } = await call
  throwIfFailed(error, status)
  return ClientHitRows.parse(data).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    phoneE164: row.phone_e164,
    lastVisitAt: row.last_visit_at,
  }))
}

/** The card: details, history, notes, consents, counters and the E18 value, family-wide. */
export async function fetchClientCard(
  businessId: string,
  clientId: string,
  signal?: AbortSignal,
): Promise<ClientCard> {
  const args: Args<'client_card'> = { p_business_id: businessId, p_client_id: clientId }
  let call = supabase.rpc('client_card', args)
  if (signal) call = call.abortSignal(signal)
  const { data, error, status } = await call
  throwIfFailed(error, status)
  return toClientCard(data)
}

/**
 * The consent switch (contract 1.8 D8): on = a new `staff_ui` record (with who gave it and the
 * version of the text the staff member confirmed), off = the withdrawal of the family's active
 * grants. The server decides from the state, so a retry changes nothing twice.
 */
export async function setClientConsent(
  businessId: string,
  input: ConsentInput,
): Promise<SetConsentResult> {
  const args: Args<'set_client_consent'> = {
    p_business_id: businessId,
    p_client_id: input.clientId,
    p_purpose: input.purpose,
    p_granted: input.granted,
    ...(input.granted
      ? { p_given_by: input.givenBy ?? 'client', p_policy_version: STAFF_CONSENT_NOTICE_VERSION }
      : {}),
  }
  const { data, error, status } = await supabase
    .rpc('set_client_consent', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return toSetConsentResult(data)
}

/** A note with the id of its attempt: the retry of a committed note inserts nothing (success). */
export async function addClientNote(businessId: string, input: NoteInput): Promise<void> {
  const { error, status } = await supabase
    .from('client_notes')
    .upsert(
      {
        id: input.id,
        business_id: businessId,
        client_id: input.clientId,
        author_id: input.authorId,
        body: input.body,
      },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
}

/** Deletes one note; returns how many rows went (0 = already gone: not an error). */
export async function deleteClientNote(businessId: string, noteId: string): Promise<number> {
  const { data, error, status } = await supabase
    .from('client_notes')
    .delete()
    .eq('business_id', businessId)
    .eq('id', noteId)
    .select('id')
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return data?.length ?? 0
}

/** Name, mobile and message language (the 0002 column grants); no row back = `gone`. */
export async function updateClientDetails(
  businessId: string,
  clientId: string,
  input: DetailsInput,
): Promise<void> {
  const { data, error, status } = await supabase
    .from('clients')
    .update({ full_name: input.fullName, phone_e164: input.phoneE164, locale: input.locale })
    .eq('business_id', businessId)
    .eq('id', clientId)
    .select('id')
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  if (!data || data.length === 0) throw new RpcFailure({ kind: 'gone' })
}

/**
 * Anonymisation (owner, critical: the server asks for a fresh code, the caller wraps this in
 * `useStepUp`). A committed erase answers `erased: false` on its retry: still a success.
 */
export async function eraseClient(businessId: string, clientId: string): Promise<EraseResult> {
  const args: Args<'erase_client'> = { p_business_id: businessId, p_client_id: clientId }
  const { data, error, status } = await supabase
    .rpc('erase_client', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return toEraseResult(data)
}
