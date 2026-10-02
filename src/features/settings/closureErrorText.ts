import type { TFunction } from 'i18next'
import { CLOSURE_ERROR_PARAMS, CLOSURE_ERRORS, type ClosureErrorKey } from './closureRows'
import { TIME_OFF_ERRORS, type TimeOffErrorKey } from './timeOffRange'

const CLOSURE_KEYS: readonly string[] = Object.values(CLOSURE_ERRORS)
const TIME_OFF_KEYS: readonly string[] = Object.values(TIME_OFF_ERRORS)

/**
 * The text of a field error of `ClosureSheet`: the schema carries i18n keys, not texts; anything
 * else (never expected) says «Κάποια τιμή δεν είναι έγκυρη».
 */
export function closureErrorText(t: TFunction<'pro'>, message: string | undefined): string | null {
  if (!message) return null
  if (!CLOSURE_KEYS.includes(message)) return t('errors.invalid')
  const key = message as ClosureErrorKey
  return t(key, { ...CLOSURE_ERROR_PARAMS[key] })
}

/** The same for `TimeOffSheet`. */
export function timeOffErrorText(t: TFunction<'pro'>, message: string | undefined): string | null {
  if (!message) return null
  return TIME_OFF_KEYS.includes(message) ? t(message as TimeOffErrorKey) : t('errors.invalid')
}
