import {
  ManageCancelResponse,
  ManageRescheduleResponse,
  ManageSlotsResponse,
  ManageViewResponse,
} from '@fn-shared/booking-schemas.ts'
import type { LocalDate } from '@/shared/lib/localDates'
import { postPublicApi } from '@/shared/lib/publicApi'

/**
 * `POST /api/functions/v1/manage` (contract 1.3 §5). The token of `/m/<token>` is the only
 * credential; everything is POST, so link previews and prefetchers never change anything.
 */
const PATH = '/functions/v1/manage'

export function manageView(token: string, signal?: AbortSignal) {
  return postPublicApi(PATH, { action: 'view', token }, ManageViewResponse, { signal })
}

/** Starts a reschedule may use: same staff member, the booking's own length (≤ 14 days). */
export function manageSlots(token: string, from: LocalDate, to: LocalDate, signal?: AbortSignal) {
  return postPublicApi(PATH, { action: 'slots', token, from, to }, ManageSlotsResponse, { signal })
}

/** Revokes every link of the appointment: reopening this one answers AN015. */
export function manageCancel(token: string) {
  return postPublicApi(PATH, { action: 'cancel', token }, ManageCancelResponse)
}

export function manageReschedule(token: string, startsAt: string) {
  return postPublicApi(
    PATH,
    { action: 'reschedule', token, starts_at: startsAt },
    ManageRescheduleResponse,
  )
}
