import type { ConsentPurpose } from '@/shared/lib/domain'
import type { ConsentRecord, CurrentConsent } from './schema'

/**
 * What the consent switch says about the current state (contract 1.8 §4.6). The state itself is
 * the server's (`consent_state`, family-wide, rule 13): this only picks the record it named, by
 * `recordId`, to say where it came from and when.
 */
export type ConsentView =
  | { readonly kind: 'none' }
  /** `soft_opt_in` from the booking form (the client could refuse there). */
  | { readonly kind: 'bookingForm'; readonly at: string | null }
  /** `consent` recorded in the shop (or by a link or an import, Phase 3). */
  | { readonly kind: 'inShop'; readonly at: string | null; readonly guardian: boolean }
  | { readonly kind: 'refused'; readonly at: string | null }

export function consentView(
  current: Readonly<Record<ConsentPurpose, CurrentConsent>>,
  records: readonly ConsentRecord[],
  purpose: ConsentPurpose = 'marketing_sms',
): ConsentView {
  const { state, recordId } = current[purpose]
  if (state === 'none') return { kind: 'none' }
  const record = records.find((candidate) => candidate.id === recordId)
  // A state without its record (never expected): the state alone, with no date.
  const at = record?.createdAt ?? null
  if (state === 'refused') return { kind: 'refused', at }
  if (record?.legalBasis === 'soft_opt_in') return { kind: 'bookingForm', at }
  return { kind: 'inShop', at, guardian: record?.givenBy === 'guardian' }
}
