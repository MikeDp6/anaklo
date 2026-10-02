import { z } from 'zod/mini'
import type { IdentityChange, IdentityField, IdentityValues } from './schema'

/**
 * The «Ταυτότητα επιχείρησης» form (contract 1.7 §6.9). Which slug is free, which zone is valid
 * and whether future appointments block a change are decided by `change_business_identity` only
 * (rule 13): the form checks that nothing is empty and lists what changes.
 */

/** Longest slug the CHECK allows (0001 `businesses_slug_format`). */
export const SLUG_MAX = 40

export const IdentityFormSchema = z.object({
  slug: z.string().check(z.refine((value) => value.trim() !== '', 'form.errors.required')),
  timeZone: z.string().check(z.minLength(1, 'form.errors.required')),
  currency: z.string().check(z.minLength(1, 'form.errors.required')),
})
export type IdentityFormValues = z.infer<typeof IdentityFormSchema>

export function toIdentityForm(values: IdentityValues): IdentityFormValues {
  return { slug: values.slug, timeZone: values.timeZone, currency: values.currency }
}

/** The slug field is lower-cased as the owner types (slugs are lower case). */
export function slugInput(value: string): string {
  return value.toLowerCase()
}

/** What the server would store: the RPC normalises the same way (`lower`, `btrim`, `upper`). */
function normalised(values: IdentityFormValues): IdentityValues {
  return {
    slug: values.slug.trim().toLowerCase(),
    timeZone: values.timeZone.trim(),
    currency: values.currency.trim().toUpperCase(),
  }
}

export interface FieldChange {
  readonly field: IdentityField
  readonly from: string
  readonly to: string
}

/** The fields that differ from what is stored, in the order slug, zone, currency. */
export function identityChanges(stored: IdentityValues, values: IdentityFormValues): FieldChange[] {
  const next = normalised(values)
  const pairs: [IdentityField, string, string][] = [
    ['slug', stored.slug, next.slug],
    ['timezone', stored.timeZone, next.timeZone],
    ['currency', stored.currency, next.currency],
  ]
  return pairs
    .filter(([, from, to]) => from !== to)
    .map(([field, from, to]) => ({ field, from, to }))
}

/** The RPC arguments of the changed fields only. */
export function toIdentityChange(changes: readonly FieldChange[]): IdentityChange {
  const value = (field: IdentityField) => changes.find((change) => change.field === field)?.to
  const slug = value('slug')
  const timeZone = value('timezone')
  const currency = value('currency')
  return {
    ...(slug !== undefined ? { slug } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(currency !== undefined ? { currency } : {}),
  }
}

type IntlKey = 'timeZone' | 'currency'

/** The engine's list (older iOS Safari has none: then only the current value is offered). */
function supported(key: IntlKey): readonly string[] {
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf(key) : []
}

/** Sorted, without duplicates, always with the stored value (an alias the engine omits). */
function withCurrent(values: readonly string[], current: string): string[] {
  return [...new Set([...values, current])].sort((a, b) => a.localeCompare(b, 'en'))
}

/** IANA zones of the engine plus the stored one (the server validates the choice). */
export function timeZoneOptions(
  current: string,
  values: readonly string[] = supported('timeZone'),
): string[] {
  return withCurrent(values, current)
}

/** ISO 4217 codes of the engine plus the stored one. */
export function currencyCodes(
  current: string,
  values: readonly string[] = supported('currency'),
): string[] {
  return withCurrent(values, current)
}

/** «EUR · ευρώ» in the UI language; the bare code when the engine has no name for it. */
export function currencyName(code: string, language: string): string | null {
  try {
    const name = new Intl.DisplayNames([language], { type: 'currency' }).of(code)
    return name && name !== code ? name : null
  } catch {
    return null
  }
}
