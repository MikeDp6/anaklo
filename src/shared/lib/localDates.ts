// The Intl-only half of dates.ts (shared with Edge Functions, ADR-0002). The booking page imports
// dates from here, never from ./dates: that one also ships date-fns and @date-fns/tz.
export * from '@fn-shared/local-dates.ts'
