import { z } from 'zod/mini'
import { MAX_CLIENT_NAME_LENGTH } from '@fn-shared/booking-schemas.ts'
import type { BookClientInput, BookInput } from '@/features/calendar/schema'
import type { Locale } from '@/shared/lib/domain'
import { normalizePhone } from '@/shared/lib/phone'

/**
 * The quick-add form (phone booking, contract 1.4 §3.4): an existing client from the search, or
 * a new one typed inline (name, optional mobile); then service, staff member and time. Validated
 * by React Hook Form through `zodResolver` (zod/mini works with it). Messages are i18n keys of
 * the `pro` namespace. The server re-validates everything (AN007 for a client, AN001 for a time).
 */

export const QUICK_ADD_ERRORS = {
  clientRequired: 'quickAdd.errors.clientRequired',
  nameRequired: 'quickAdd.errors.nameRequired',
  nameTooLong: 'quickAdd.errors.nameTooLong',
  phoneInvalid: 'quickAdd.errors.phoneInvalid',
  serviceRequired: 'quickAdd.errors.serviceRequired',
  staffRequired: 'quickAdd.errors.staffRequired',
  timeRequired: 'quickAdd.errors.timeRequired',
} as const

export type QuickAddErrorKey = (typeof QUICK_ADD_ERRORS)[keyof typeof QUICK_ADD_ERRORS]

export const QuickAddForm = z
  .object({
    clientMode: z.enum(['existing', 'new']),
    /** The chosen client (existing mode). */
    clientId: z.nullable(z.string()),
    /** Existing mode: the chosen client's name (for the summary). New mode: what was typed. */
    clientName: z.string(),
    /** New mode only; empty = no mobile. */
    phone: z.string(),
    serviceId: z.string().check(z.minLength(1, QUICK_ADD_ERRORS.serviceRequired)),
    staffId: z.string().check(z.minLength(1, QUICK_ADD_ERRORS.staffRequired)),
    startsAt: z.string().check(z.minLength(1, QUICK_ADD_ERRORS.timeRequired)),
  })
  .check(
    z.superRefine((form, ctx) => {
      if (form.clientMode === 'existing') {
        if (!form.clientId) {
          ctx.addIssue({
            code: 'custom',
            message: QUICK_ADD_ERRORS.clientRequired,
            path: ['clientId'],
          })
        }
        return
      }
      const name = form.clientName.trim()
      if (name.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: QUICK_ADD_ERRORS.nameRequired,
          path: ['clientName'],
        })
      } else if (name.length > MAX_CLIENT_NAME_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          message: QUICK_ADD_ERRORS.nameTooLong,
          path: ['clientName'],
        })
      }
      if (form.phone.trim() !== '' && !normalizePhone(form.phone).ok) {
        ctx.addIssue({ code: 'custom', message: QUICK_ADD_ERRORS.phoneInvalid, path: ['phone'] })
      }
    }),
  )

export type QuickAddValues = z.infer<typeof QuickAddForm>

export const EMPTY_QUICK_ADD: QuickAddValues = {
  clientMode: 'existing',
  clientId: null,
  clientName: '',
  phone: '',
  serviceId: '',
  staffId: '',
  startsAt: '',
}

/** Only the client fields: the first step checks them before moving on. */
export function isClientStepValid(form: QuickAddValues): boolean {
  if (form.clientMode === 'existing') return form.clientId !== null
  const name = form.clientName.trim()
  return (
    name.length > 0 &&
    name.length <= MAX_CLIENT_NAME_LENGTH &&
    (form.phone.trim() === '' || normalizePhone(form.phone).ok)
  )
}

export function toBookClient(form: QuickAddValues, locale: Locale): BookClientInput {
  if (form.clientMode === 'existing' && form.clientId) {
    return { kind: 'existing', clientId: form.clientId }
  }
  const phone = form.phone.trim() === '' ? null : normalizePhone(form.phone)
  return {
    kind: 'new',
    fullName: form.clientName.trim(),
    phoneE164: phone?.ok ? phone.e164 : null,
    locale,
  }
}

/**
 * The booking payload without its key (the attempt key is derived from exactly this).
 * `locale`: the language of the new client's messages (the business's by default).
 */
export function quickAddPayload(
  form: QuickAddValues,
  options: { locale: Locale; allowOutsideHours: boolean; allowBufferOverlap: boolean },
): Omit<BookInput, 'idempotencyKey'> {
  return {
    serviceIds: [form.serviceId],
    staffId: form.staffId,
    startsAt: form.startsAt,
    source: 'phone',
    allowOutsideHours: options.allowOutsideHours,
    allowBufferOverlap: options.allowBufferOverlap,
    client: toBookClient(form, options.locale),
  }
}
