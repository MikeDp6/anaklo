import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatPhone } from '@/shared/lib/phone'
import { ButtonLink } from '@/shared/ui/ButtonLink'
import { CALL_THE_SHOP_CODES, useErrorText } from '../../hooks/useErrorText'
import styles from './later.module.css'

/**
 * An error of the current step, as text from i18n (never the server's message). When SMS or
 * online changes cannot help (AN012, AN013, AN016, AN017), the business phone as a call link.
 */
export function StepError({
  code,
  phone,
  action,
}: {
  code: string
  /** `business.phone_e164` from the catalogue (contract decision 16). */
  phone: string | null
  action?: ReactNode
}) {
  const { t } = useTranslation('booking')
  const errorText = useErrorText()
  const call = phone !== null && CALL_THE_SHOP_CODES.has(code)
  return (
    <div className={styles.alert} role="alert">
      <p>{errorText(code)}</p>
      {call && (
        <ButtonLink href={`tel:${phone}`} variant="primary" block>
          {t('call.action', { phone: formatPhone(phone) })}
        </ButtonLink>
      )}
      {action}
    </div>
  )
}
