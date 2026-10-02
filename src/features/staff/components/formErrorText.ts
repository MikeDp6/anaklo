import type { TFunction } from 'i18next'

/** The i18n keys (`pro`) the catalogue form schemas put in their issues (contract 1.6 §4.12). */
const FORM_ERROR_KEYS = [
  'form.errors.required',
  'form.errors.range',
  'form.errors.endBeforeStart',
  'services.errors.name',
  'services.errors.price',
  'staffSettings.errors.name',
  'hours.errors.overlap',
  'hours.errors.time',
  'hours.errors.tooMany',
] as const
type FormErrorKey = (typeof FORM_ERROR_KEYS)[number]

function isFormErrorKey(message: string): message is FormErrorKey {
  return (FORM_ERROR_KEYS as readonly string[]).includes(message)
}

/**
 * The text of a field error. Schemas carry i18n keys, not texts; `params` fills «Από {{min}} έως
 * {{max}}.» and «Έως {{max}}…». Anything else (never expected) says «Κάποια τιμή δεν είναι
 * έγκυρη».
 */
export function formErrorText(
  t: TFunction<'pro'>,
  message: string | undefined,
  params: { readonly min?: number; readonly max?: number } = {},
): string | null {
  if (!message) return null
  return isFormErrorKey(message) ? t(message, { ...params }) : t('errors.invalid')
}
