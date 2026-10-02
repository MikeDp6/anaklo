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

/** `schedule_conflicts` arguments (contract 1.6 §3.2); null = the server's default. */
export interface ConflictsKeyQuery {
  readonly staffId: string | null
  /** An instant (ISO); null = now. */
  readonly from: string | null
  /** An instant (ISO); null = the 366-day horizon. */
  readonly to: string | null
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

  // Settings (contract 1.6 §3.3).
  /** Prefix of every day key (`day`, `dayFrame`, `staffDay`). */
  dayAll: (businessId: string) => ['pro', businessId, 'day'] as const,
  /** Active and inactive services with their staff terms; under `services`: one invalidation. */
  serviceCatalogue: (businessId: string) => ['pro', businessId, 'services', 'catalogue'] as const,
  categories: (businessId: string) => ['pro', businessId, 'categories'] as const,
  weekHoursAll: (businessId: string) => ['pro', businessId, 'week-hours'] as const,
  weekHours: (businessId: string, staffId: string) =>
    ['pro', businessId, 'week-hours', staffId] as const,
  /** Under `business`: invalidating the business refreshes the policy too. */
  bookingPolicy: (businessId: string) => ['pro', businessId, 'business', 'policy'] as const,
  exceptionsAll: (businessId: string) => ['pro', businessId, 'exceptions'] as const,
  exceptions: (businessId: string, fromDate: LocalDate) =>
    ['pro', businessId, 'exceptions', fromDate] as const,
  timeOff: (businessId: string) => ['pro', businessId, 'time-off'] as const,
  conflictsAll: (businessId: string) => ['pro', businessId, 'conflicts'] as const,
  conflicts: (businessId: string, query: ConflictsKeyQuery) =>
    [
      'pro',
      businessId,
      'conflicts',
      query.staffId ?? 'all',
      query.from ?? 'now',
      query.to ?? 'horizon',
    ] as const,
  reassignAll: (businessId: string) => ['pro', businessId, 'reassign'] as const,
  reassign: (businessId: string, appointmentId: string) =>
    ['pro', businessId, 'reassign', appointmentId] as const,
} as const
