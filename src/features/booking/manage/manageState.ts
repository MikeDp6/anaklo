import type { ManageViewResponse } from '@fn-shared/booking-schemas.ts'

/**
 * What the manage link offers for its appointment:
 * - `changeable`: cancel (and move) online, until `change_until`;
 * - `call`: still ahead but inside the notice window, so the shop decides: call it;
 * - `closed`: completed, no-show or already over (the link works 30 days after the end): nothing
 *   to change and nobody to call about it;
 * - `cancelled`: cancelled (by the shop: a client cancel revokes the link).
 */
export type ManageState = 'changeable' | 'call' | 'closed' | 'cancelled'

export function manageState(view: ManageViewResponse, now: number): ManageState {
  const { status, ends_at } = view.appointment
  if (status === 'cancelled') return 'cancelled'
  if (status === 'completed' || status === 'no_show' || Date.parse(ends_at) <= now) return 'closed'
  return view.can_cancel ? 'changeable' : 'call'
}
