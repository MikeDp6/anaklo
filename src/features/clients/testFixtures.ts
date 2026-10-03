import { toClientCard, type LiveClientCard } from './schema'

/** Synthetic test data of the client Vitest files (the demo shop of the seed). Never bundled. */
export const CLIENT_IDS = {
  business: '00000000-0000-4000-8000-000000000001',
  nikos: '00000000-0000-4000-8000-000000000101',
  alex: '00000000-0000-4000-8000-000000000102',
  owner: '00000000-0000-4000-8000-00000000a001',
  staffUser: '00000000-0000-4000-8000-00000000a003',
  client: '00000000-0000-4000-8000-00000000c001',
  merged: '00000000-0000-4000-8000-00000000c002',
  past: '00000000-0000-4000-8000-00000000d001',
  colleague: '00000000-0000-4000-8000-00000000d002',
  future: '00000000-0000-4000-8000-00000000d003',
  note: '00000000-0000-4000-8000-00000000e001',
  otherNote: '00000000-0000-4000-8000-00000000e002',
  grant: '00000000-0000-4000-8000-00000000f001',
  refusal: '00000000-0000-4000-8000-00000000f002',
} as const

type Json = Record<string, unknown>

const NONE = { state: 'none', record_id: null }

/**
 * `client_card` as the server answers it for a live client (contract 1.8 §2.6), seen by the
 * owner: Γιώργος Π., two past appointments (Νίκος's with an amount, Άλεξ's), one upcoming, two
 * notes, a booking-form grant of marketing SMS. `patch` replaces top-level keys.
 */
export function liveCardJson(patch: Json = {}): Json {
  return {
    state: 'live',
    client_id: CLIENT_IDS.client,
    as_of: '2026-10-03T09:00:00.123456+00:00',
    timezone: 'Europe/Athens',
    currency: 'EUR',
    details: {
      full_name: 'Γιώργος Π.',
      phone_e164: '+306900000001',
      phone_verified_at: '2026-09-01T10:00:00+00:00',
      email: null,
      birthday: null,
      locale: 'el',
      source: 'online',
      created_at: '2025-03-01T10:00:00.5+00:00',
      aliases: [],
    },
    counters: {
      visits: 2,
      last_visit_at: '2026-09-23T07:00:00+00:00',
      last_visit_date: '2026-09-23',
      no_shows: 0,
    },
    ring: {
      state: 'within',
      days_since_last: 10,
      interval_days: 28,
      interval_weeks: 4,
      fraction: 0.36,
      overdue_days: null,
      hint_key: 'nextVisit.vertical',
    },
    upcoming: [
      cardItemJson({
        appointment_id: CLIENT_IDS.future,
        starts_at: '2026-10-07T07:00:00+00:00',
        ends_at: '2026-10-07T07:30:00+00:00',
        status: 'booked',
      }),
    ],
    history: [
      cardItemJson({ appointment_id: CLIENT_IDS.past, amount_cents: 1300 }),
      cardItemJson({
        appointment_id: CLIENT_IDS.colleague,
        starts_at: '2026-08-26T07:00:00+00:00',
        ends_at: '2026-08-26T07:30:00+00:00',
        staff_id: CLIENT_IDS.alex,
        staff_name: 'Άλεξ',
        amount_cents: 1500,
        own: false,
      }),
    ],
    history_total: 2,
    notes: [
      {
        id: CLIENT_IDS.note,
        body: 'Θέλει κοντά στο πλάι.\nΌχι λακ.',
        created_at: '2026-09-23T07:40:00+00:00',
        by_me: true,
        author_name: 'Νίκος',
        author_role: 'owner',
        can_delete: true,
      },
      {
        id: CLIENT_IDS.otherNote,
        body: 'Προτιμά πρωινές ώρες.',
        created_at: '2026-08-26T07:40:00+00:00',
        by_me: false,
        author_name: 'Άλεξ',
        author_role: 'staff',
        can_delete: true,
      },
    ],
    notes_total: 2,
    consents: {
      current: {
        marketing_sms: { state: 'granted', record_id: CLIENT_IDS.grant },
        marketing_email: NONE,
        photos_record: NONE,
        photos_publish: NONE,
      },
      records: [
        {
          id: CLIENT_IDS.grant,
          client_id: CLIENT_IDS.client,
          purpose: 'marketing_sms',
          legal_basis: 'soft_opt_in',
          granted: true,
          source: 'booking_form',
          given_by: 'client',
          policy_version: 'booking-notice-2026-09-28',
          created_at: '2026-09-01T10:00:00+00:00',
          withdrawn_at: null,
        },
      ],
    },
    can: { erase: true, merge: true },
    ...patch,
  }
}

/** One appointment of the card: Νίκος's completed haircut of 2026-09-23 10:00 Athens. */
export function cardItemJson(patch: Json = {}): Json {
  return {
    appointment_id: CLIENT_IDS.past,
    starts_at: '2026-09-23T07:00:00+00:00',
    ends_at: '2026-09-23T07:30:00+00:00',
    status: 'completed',
    source: 'online',
    staff_id: CLIENT_IDS.nikos,
    staff_name: 'Νίκος',
    service_names: ['Κούρεμα'],
    amount_cents: 1300,
    own: true,
    ...patch,
  }
}

export function liveCard(patch: Json = {}): LiveClientCard {
  const card = toClientCard(liveCardJson(patch))
  if (card.state !== 'live') throw new Error('not a live card')
  return card
}
