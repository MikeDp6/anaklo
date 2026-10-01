import type { LocalDate } from './localDates'

/**
 * TanStack Query keys of the pro app (contract 1.4 §3.2). Every key starts with the business,
 * then the business-local day and the staff member, so one invalidation path
 * (`features/calendar/invalidate.ts`) serves the mutations now and Realtime in Phase 3.
 * `date` is always a business-local `yyyy-MM-dd` (`toLocalDate(instant, businesses.timezone)`).
 */

export interface SlotsQuery {
  readonly serviceIds: readonly string[]
  readonly staffId?: string | null
  readonly from: LocalDate
  readonly to: LocalDate
  readonly excludeAppointmentId?: string | null
}

export const proKeys = {
  all: (businessId: string) => ['pro', businessId] as const,
  business: (businessId: string) => ['pro', businessId, 'business'] as const,
  staff: (businessId: string) => ['pro', businessId, 'staff'] as const,
  services: (businessId: string) => ['pro', businessId, 'services'] as const,
  /** Prefix of `dayFrame` and `staffDay`: invalidating it refreshes the whole day. */
  day: (businessId: string, date: LocalDate) => ['pro', businessId, 'day', date] as const,
  dayFrame: (businessId: string, date: LocalDate) =>
    ['pro', businessId, 'day', date, 'frame'] as const,
  staffDay: (businessId: string, date: LocalDate, staffId: string) =>
    ['pro', businessId, 'day', date, 'staff', staffId] as const,
  /** Prefix of every `today` key (the date rolls over at local midnight). */
  todayAll: (businessId: string) => ['pro', businessId, 'today'] as const,
  today: (businessId: string, date: LocalDate) => ['pro', businessId, 'today', date] as const,
  /** Prefix of every `slots` key. */
  slotsAll: (businessId: string) => ['pro', businessId, 'slots'] as const,
  slots: (businessId: string, query: SlotsQuery) =>
    [
      'pro',
      businessId,
      'slots',
      query.serviceIds.join(','),
      query.staffId ?? 'any',
      query.from,
      query.to,
      query.excludeAppointmentId ?? '-',
    ] as const,
  clientSearch: (businessId: string, query: string) =>
    ['pro', businessId, 'clients', 'search', query.trim()] as const,
  /**
   * The signed-in user's own push subscriptions (contract 1.5 §4.3). Per user, not per business
   * (ADR-0010 §2), hence `'user'` where the other keys have the business.
   */
  pushSubscriptions: (userId: string) => ['pro', 'user', userId, 'push-subscriptions'] as const,
} as const
