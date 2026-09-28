import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { isDomainErrorCode } from '@fn-shared/errors.ts'

/**
 * Codes after which the page offers the business phone as a call link (contract §4): the SMS
 * cannot help (AN012 locked, AN013 rate limit, AN017 SMS unavailable) or it is too late to change
 * online (AN016).
 */
export const CALL_THE_SHOP_CODES: ReadonlySet<string> = new Set([
  'AN012',
  'AN013',
  'AN016',
  'AN017',
])

/** The text of an error code: `errors.<AN0xx>` of `common`, else a generic one. Never `message`. */
export function useErrorText(): (code: string) => string {
  const { t } = useTranslation()
  return useCallback(
    (code: string) => {
      if (isDomainErrorCode(code)) return t(`errors.${code}`)
      return code === 'network' ? t('errors.network') : t('errors.unknown')
    },
    [t],
  )
}
