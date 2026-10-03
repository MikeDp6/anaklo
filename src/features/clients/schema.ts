import { z } from 'zod/mini'
import {
  CurrencyCode,
  Id,
  Instant,
  LocalDateString,
  MAX_CLIENT_NAME_LENGTH,
  NEXT_VISIT_HINT_KEYS,
} from '@fn-shared/booking-schemas.ts'
import {
  AppointmentSource,
  AppointmentStatus,
  CLIENT_SOURCES,
  CONSENT_GIVEN_BY,
  CONSENT_SOURCES,
  ConsentPurpose,
  ConsentState,
  LEGAL_BASES,
  Locale,
  MemberRole,
  RingState,
} from '@/shared/lib/domain'
import type { LocalDate } from '@/shared/lib/localDates'
import { normalizePhone } from '@/shared/lib/phone'

/**
 * The client feature (contracts 1.4 §2.6.7 for the search, 1.8 §3.2 for the card). Server answers
 * are parsed with zod/mini (snake_case) and mapped to the camelCase types below by `api.ts`.
 * The card is parsed strictly: exactly the keys of contract 1.8 §2.6, so a server that drifted
 * from the contract fails loudly instead of showing half a card.
 */

// ---------------------------------------------------------------------------------------------
// search_clients (1.4)
// ---------------------------------------------------------------------------------------------

export const ClientHitRows = z.array(
  z.object({
    id: Id,
    full_name: z.string(),
    phone_e164: z.nullable(z.string()),
    last_visit_at: z.nullable(Instant),
  }),
)

/** One result of `search_clients` (at most 20, ordered by the server). */
export interface ClientHit {
  readonly id: string
  readonly fullName: string
  readonly phoneE164: string | null
  readonly lastVisitAt: string | null
}

/** The search starts from 2 characters (the server also ignores shorter queries). */
export const MIN_SEARCH_LENGTH = 2

/** `search_clients` refuses a longer query (22023): the box stops there and so does the query. */
export const MAX_SEARCH_LENGTH = 100

// ---------------------------------------------------------------------------------------------
// client_card (contract 1.8 §2.6)
// ---------------------------------------------------------------------------------------------

/**
 * The version of the text the staff member confirms when recording a consent in the shop
 * (`pro:clients.consents.confirmBody`): bump it whenever that text changes. 1–40 characters (the
 * 0002 CHECK on `policy_version`).
 */
export const STAFF_CONSENT_NOTICE_VERSION = 'staff-consent-2026-10-03'

const Count = z.int().check(z.gte(0))
const Cents = z.int().check(z.gte(0))
const HintKey = z.enum(NEXT_VISIT_HINT_KEYS)

const CardItemJson = z.strictObject({
  appointment_id: Id,
  starts_at: Instant,
  ends_at: Instant,
  status: AppointmentStatus,
  source: AppointmentSource,
  staff_id: Id,
  staff_name: z.nullable(z.string()),
  service_names: z.array(z.string()),
  amount_cents: z.nullable(Cents),
  own: z.boolean(),
})

const NoteJson = z.strictObject({
  id: Id,
  body: z.string(),
  created_at: Instant,
  by_me: z.boolean(),
  author_name: z.nullable(z.string()),
  author_role: z.nullable(MemberRole),
  can_delete: z.boolean(),
})

const CurrentConsentJson = z.strictObject({ state: ConsentState, record_id: z.nullable(Id) })

const ConsentRecordJson = z.strictObject({
  id: Id,
  client_id: Id,
  purpose: ConsentPurpose,
  legal_basis: z.enum(LEGAL_BASES),
  granted: z.boolean(),
  source: z.enum(CONSENT_SOURCES),
  given_by: z.enum(CONSENT_GIVEN_BY),
  policy_version: z.string(),
  created_at: Instant,
  withdrawn_at: z.nullable(Instant),
})

const LiveCardJson = z.strictObject({
  state: z.literal('live'),
  client_id: Id,
  as_of: Instant,
  timezone: z.string(),
  currency: CurrencyCode,
  details: z.strictObject({
    full_name: z.string(),
    phone_e164: z.nullable(z.string()),
    phone_verified_at: z.nullable(Instant),
    email: z.nullable(z.string()),
    birthday: z.nullable(LocalDateString),
    locale: Locale,
    source: z.enum(CLIENT_SOURCES),
    created_at: Instant,
    aliases: z.array(
      z.strictObject({ client_id: Id, full_name: z.string(), phone_e164: z.nullable(z.string()) }),
    ),
  }),
  counters: z.strictObject({
    visits: Count,
    last_visit_at: z.nullable(Instant),
    last_visit_date: z.nullable(LocalDateString),
    no_shows: Count,
  }),
  ring: z.strictObject({
    state: RingState,
    days_since_last: z.nullable(Count),
    interval_days: z.nullable(Count),
    interval_weeks: z.nullable(Count),
    fraction: z.nullable(z.number()),
    overdue_days: z.nullable(Count),
    hint_key: z.nullable(HintKey),
  }),
  upcoming: z.array(CardItemJson),
  history: z.array(CardItemJson),
  history_total: Count,
  notes: z.array(NoteJson),
  notes_total: Count,
  consents: z.strictObject({
    current: z.strictObject({
      marketing_sms: CurrentConsentJson,
      marketing_email: CurrentConsentJson,
      photos_record: CurrentConsentJson,
      photos_publish: CurrentConsentJson,
    }),
    records: z.array(ConsentRecordJson),
  }),
  can: z.strictObject({ erase: z.boolean(), merge: z.boolean() }),
})

export const ClientCardJson = z.discriminatedUnion('state', [
  LiveCardJson,
  z.strictObject({ state: z.literal('merged'), client_id: Id, merged_into_id: Id }),
  z.strictObject({ state: z.literal('erased'), client_id: Id, erased_at: Instant }),
])
export type ClientCardJson = z.infer<typeof ClientCardJson>
type LiveCardJson = z.infer<typeof LiveCardJson>

export interface ClientCardItem {
  readonly appointmentId: string
  readonly startsAt: string
  readonly endsAt: string
  readonly status: AppointmentStatus
  readonly source: AppointmentSource
  readonly staffId: string
  readonly staffName: string | null
  readonly serviceNames: readonly string[]
  /** null: no amount (cancelled, no-show) or not this member's to see (decided in SQL). */
  readonly amountCents: number | null
  /** The signed-in member's own appointment. */
  readonly own: boolean
}

export interface ClientNote {
  readonly id: string
  readonly body: string
  readonly createdAt: string
  readonly byMe: boolean
  readonly authorName: string | null
  /** null: the author is no longer a member (or the account is gone). */
  readonly authorRole: MemberRole | null
  readonly canDelete: boolean
}

export interface ConsentRecord {
  readonly id: string
  readonly clientId: string
  readonly purpose: ConsentPurpose
  readonly legalBasis: (typeof LEGAL_BASES)[number]
  readonly granted: boolean
  readonly source: (typeof CONSENT_SOURCES)[number]
  readonly givenBy: (typeof CONSENT_GIVEN_BY)[number]
  readonly policyVersion: string
  readonly createdAt: string
  readonly withdrawnAt: string | null
}

export interface CurrentConsent {
  readonly state: ConsentState
  readonly recordId: string | null
}

/** E18: computed by the server (rule 13); the browser only draws it. */
export interface ClientRing {
  readonly state: RingState
  readonly daysSinceLast: number | null
  readonly intervalDays: number | null
  readonly intervalWeeks: number | null
  /** 0–1 (two decimals); null without an interval to compare with. */
  readonly fraction: number | null
  readonly overdueDays: number | null
  readonly hintKey: (typeof NEXT_VISIT_HINT_KEYS)[number] | null
}

export interface ClientAlias {
  readonly clientId: string
  readonly fullName: string
  readonly phoneE164: string | null
}

export interface LiveClientCard {
  readonly state: 'live'
  readonly clientId: string
  readonly asOf: string
  readonly timeZone: string
  readonly currency: string
  readonly details: {
    readonly fullName: string
    readonly phoneE164: string | null
    readonly phoneVerifiedAt: string | null
    readonly email: string | null
    readonly birthday: LocalDate | null
    readonly locale: Locale
    readonly source: (typeof CLIENT_SOURCES)[number]
    readonly createdAt: string
    readonly aliases: readonly ClientAlias[]
  }
  readonly counters: {
    readonly visits: number
    readonly lastVisitAt: string | null
    readonly lastVisitDate: LocalDate | null
    readonly noShows: number
  }
  readonly ring: ClientRing
  readonly upcoming: readonly ClientCardItem[]
  readonly history: readonly ClientCardItem[]
  readonly historyTotal: number
  readonly notes: readonly ClientNote[]
  readonly notesTotal: number
  readonly consents: {
    readonly current: Readonly<Record<ConsentPurpose, CurrentConsent>>
    readonly records: readonly ConsentRecord[]
  }
  readonly can: { readonly erase: boolean; readonly merge: boolean }
}

export type ClientCard =
  | { readonly state: 'merged'; readonly clientId: string; readonly mergedIntoId: string }
  | { readonly state: 'erased'; readonly clientId: string; readonly erasedAt: string }
  | LiveClientCard

function toItem(item: z.infer<typeof CardItemJson>): ClientCardItem {
  return {
    appointmentId: item.appointment_id,
    startsAt: item.starts_at,
    endsAt: item.ends_at,
    status: item.status,
    source: item.source,
    staffId: item.staff_id,
    staffName: item.staff_name,
    serviceNames: item.service_names,
    amountCents: item.amount_cents,
    own: item.own,
  }
}

function toCurrent(current: z.infer<typeof CurrentConsentJson>): CurrentConsent {
  return { state: current.state, recordId: current.record_id }
}

function toLiveCard(card: LiveCardJson): LiveClientCard {
  const { details, counters, ring, consents } = card
  return {
    state: 'live',
    clientId: card.client_id,
    asOf: card.as_of,
    timeZone: card.timezone,
    currency: card.currency,
    details: {
      fullName: details.full_name,
      phoneE164: details.phone_e164,
      phoneVerifiedAt: details.phone_verified_at,
      email: details.email,
      birthday: details.birthday,
      locale: details.locale,
      source: details.source,
      createdAt: details.created_at,
      aliases: details.aliases.map((alias) => ({
        clientId: alias.client_id,
        fullName: alias.full_name,
        phoneE164: alias.phone_e164,
      })),
    },
    counters: {
      visits: counters.visits,
      lastVisitAt: counters.last_visit_at,
      lastVisitDate: counters.last_visit_date,
      noShows: counters.no_shows,
    },
    ring: {
      state: ring.state,
      daysSinceLast: ring.days_since_last,
      intervalDays: ring.interval_days,
      intervalWeeks: ring.interval_weeks,
      fraction: ring.fraction,
      overdueDays: ring.overdue_days,
      hintKey: ring.hint_key,
    },
    upcoming: card.upcoming.map(toItem),
    history: card.history.map(toItem),
    historyTotal: card.history_total,
    notes: card.notes.map((note) => ({
      id: note.id,
      body: note.body,
      createdAt: note.created_at,
      byMe: note.by_me,
      authorName: note.author_name,
      authorRole: note.author_role,
      canDelete: note.can_delete,
    })),
    notesTotal: card.notes_total,
    consents: {
      current: {
        marketing_sms: toCurrent(consents.current.marketing_sms),
        marketing_email: toCurrent(consents.current.marketing_email),
        photos_record: toCurrent(consents.current.photos_record),
        photos_publish: toCurrent(consents.current.photos_publish),
      },
      records: consents.records.map((record) => ({
        id: record.id,
        clientId: record.client_id,
        purpose: record.purpose,
        legalBasis: record.legal_basis,
        granted: record.granted,
        source: record.source,
        givenBy: record.given_by,
        policyVersion: record.policy_version,
        createdAt: record.created_at,
        withdrawnAt: record.withdrawn_at,
      })),
    },
    can: card.can,
  }
}

/** The parsed answer of `client_card`, in the app's shape. */
export function toClientCard(data: unknown): ClientCard {
  const card = ClientCardJson.parse(data)
  switch (card.state) {
    case 'merged':
      return { state: 'merged', clientId: card.client_id, mergedIntoId: card.merged_into_id }
    case 'erased':
      return { state: 'erased', clientId: card.client_id, erasedAt: card.erased_at }
    case 'live':
      return toLiveCard(card)
  }
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export interface ConsentInput {
  readonly clientId: string
  readonly purpose: ConsentPurpose
  readonly granted: boolean
  /** Only when granting; null when withdrawing. */
  readonly givenBy: (typeof CONSENT_GIVEN_BY)[number] | null
}

/** `state` is the family's state after the call (the server's `consent_state`). */
const StateAfter = z.union([ConsentState, z.object({ state: ConsentState })])

export const SetConsentResponse = z.object({
  client_id: Id,
  purpose: ConsentPurpose,
  state: StateAfter,
  changed: z.boolean(),
  consent_id: z.nullable(Id),
  withdrawn: Count,
})

export interface SetConsentResult {
  readonly clientId: string
  readonly purpose: ConsentPurpose
  readonly state: ConsentState
  readonly changed: boolean
  readonly consentId: string | null
  readonly withdrawn: number
}

export function toSetConsentResult(data: unknown): SetConsentResult {
  const result = SetConsentResponse.parse(data)
  return {
    clientId: result.client_id,
    purpose: result.purpose,
    state: typeof result.state === 'string' ? result.state : result.state.state,
    changed: result.changed,
    consentId: result.consent_id,
    withdrawn: result.withdrawn,
  }
}

/** A note to add; `id` = `crypto.randomUUID()` per attempt, kept for its identical retry. */
export interface NoteInput {
  readonly id: string
  readonly clientId: string
  readonly authorId: string
  readonly body: string
}

export interface DetailsInput {
  readonly fullName: string
  readonly phoneE164: string | null
  readonly locale: Locale
}

export const EraseResponse = z.object({
  client_id: Id,
  erased: z.boolean(),
  erased_at: Instant,
  erased_ids: z.array(Id),
  appointments_kept: Count,
  notes_deleted: Count,
  consents_deleted: Count,
  messages_wiped: Count,
  otp_challenges_wiped: Count,
  devices_revoked: Count,
  tokens_revoked: Count,
  suppressed: Count,
})

export interface EraseResult {
  readonly clientId: string
  /** false: it was already erased (a retry of a committed erase): still a success. */
  readonly erased: boolean
  readonly erasedAt: string
  readonly erasedIds: readonly string[]
  readonly appointmentsKept: number
  readonly notesDeleted: number
  readonly consentsDeleted: number
  readonly messagesWiped: number
  readonly otpChallengesWiped: number
  readonly devicesRevoked: number
  readonly tokensRevoked: number
  readonly suppressed: number
}

export function toEraseResult(data: unknown): EraseResult {
  const result = EraseResponse.parse(data)
  return {
    clientId: result.client_id,
    erased: result.erased,
    erasedAt: result.erased_at,
    erasedIds: result.erased_ids,
    appointmentsKept: result.appointments_kept,
    notesDeleted: result.notes_deleted,
    consentsDeleted: result.consents_deleted,
    messagesWiped: result.messages_wiped,
    otpChallengesWiped: result.otp_challenges_wiped,
    devicesRevoked: result.devices_revoked,
    tokensRevoked: result.tokens_revoked,
    suppressed: result.suppressed,
  }
}

// ---------------------------------------------------------------------------------------------
// Forms (React Hook Form through zodResolver). Messages are i18n keys of the `pro` namespace.
// ---------------------------------------------------------------------------------------------

/** `client_notes.body`: 1–2000 characters (`char_length`, the 0002 CHECK). */
export const MAX_NOTE_LENGTH = 2000

export const CLIENT_FORM_ERRORS = {
  noteRequired: 'clients.notes.errors.required',
  noteTooLong: 'clients.notes.errors.tooLong',
  nameRequired: 'clients.edit.errors.nameRequired',
  nameTooLong: 'clients.edit.errors.nameTooLong',
  phoneInvalid: 'clients.edit.errors.phoneInvalid',
} as const

export type ClientFormErrorKey = (typeof CLIENT_FORM_ERRORS)[keyof typeof CLIENT_FORM_ERRORS]

/** Characters as the database counts them (`char_length` counts code points). */
export function charLength(text: string): number {
  return Array.from(text).length
}

export const NoteForm = z.object({
  body: z.string().check(
    z.superRefine((body, ctx) => {
      const length = charLength(body.trim())
      if (length === 0) ctx.addIssue({ code: 'custom', message: CLIENT_FORM_ERRORS.noteRequired })
      else if (length > MAX_NOTE_LENGTH) {
        ctx.addIssue({ code: 'custom', message: CLIENT_FORM_ERRORS.noteTooLong })
      }
    }),
  ),
})
export type NoteFormValues = z.infer<typeof NoteForm>

export const ClientDetailsForm = z.object({
  fullName: z.string().check(
    z.superRefine((name, ctx) => {
      const length = charLength(name.trim())
      if (length === 0) ctx.addIssue({ code: 'custom', message: CLIENT_FORM_ERRORS.nameRequired })
      else if (length > MAX_CLIENT_NAME_LENGTH) {
        ctx.addIssue({ code: 'custom', message: CLIENT_FORM_ERRORS.nameTooLong })
      }
    }),
  ),
  /** Empty = no mobile. */
  phone: z.string().check(
    z.superRefine((phone, ctx) => {
      if (phone.trim() !== '' && !normalizePhone(phone).ok) {
        ctx.addIssue({ code: 'custom', message: CLIENT_FORM_ERRORS.phoneInvalid })
      }
    }),
  ),
  locale: Locale,
})
export type ClientDetailsValues = z.infer<typeof ClientDetailsForm>

/** What `updateClientDetails` sends for values that passed `ClientDetailsForm`. */
export function toDetailsInput(values: ClientDetailsValues): DetailsInput {
  const phone = values.phone.trim() === '' ? null : normalizePhone(values.phone)
  return {
    fullName: values.fullName.trim(),
    phoneE164: phone?.ok ? phone.e164 : null,
    locale: values.locale,
  }
}
