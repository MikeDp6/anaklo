import type { StepUpHint } from '@/shared/lib/domain'
import { failureOf, RpcFailure } from '@/shared/lib/rpcError'

/**
 * Step-up for critical actions (contract 1.7 §6.6, ADR-0009 §12–13, plan 1.7 «Φρέσκος κωδικός»).
 * The freshness rule lives only in SQL (`private.require_fresh_totp()`, rule 13): the app never
 * asks for a code on its own. A call that the server refused with `42501` and the hint
 * `aal2_required` or `fresh_totp_required` (an RPC, or `invite-member`/`manage-factors` with the
 * same body) opens the code sheet; after a verified code the call runs exactly once more.
 */
export interface StepUpDeps {
  /** Opens the code sheet; true once a code was verified, false when it was closed. */
  askForCode(hint: StepUpHint): Promise<boolean>
  /** The session or role may have changed: run the route guards again (`decideAuthRoute`). */
  onAuthRecheck(): void
}

/** The code sheet was closed: the action did not happen. */
export class StepUpCancelled extends RpcFailure {
  constructor() {
    super({ kind: 'stepUpCancelled' })
    this.name = 'StepUpCancelled'
  }
}

/**
 * 1. `call()` succeeds → its result; no sheet.
 * 2. `stepUp` → `askForCode(hint)`: closed → `StepUpCancelled`; verified → `call()` once more,
 *    and that answer (result or error, also another `stepUp`) is final: no second sheet, no third
 *    call.
 * 3. `forbidden` or `unauthorized` (first or retried call) → `onAuthRecheck()`, then rethrown.
 * 4. Anything else → rethrown.
 */
export async function withStepUp<T>(call: () => Promise<T>, deps: StepUpDeps): Promise<T> {
  let hint: StepUpHint
  try {
    return await call()
  } catch (error) {
    const failure = failureOf(error)
    if (failure.kind !== 'stepUp') {
      recheckIfNeeded(error, deps)
      throw error
    }
    hint = failure.hint
  }
  if (!(await deps.askForCode(hint))) throw new StepUpCancelled()
  try {
    return await call()
  } catch (error) {
    recheckIfNeeded(error, deps)
    throw error
  }
}

function recheckIfNeeded(error: unknown, deps: StepUpDeps): void {
  const { kind } = failureOf(error)
  if (kind === 'forbidden' || kind === 'unauthorized') deps.onAuthRecheck()
}
