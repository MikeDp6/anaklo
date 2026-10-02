import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { TextField } from '@/shared/ui/TextField'
import { useVerifyCodeForm, type VerifyPurpose } from '../hooks/useVerifyCodeForm'
import type { VerifiedFactor } from '../mfaApi'
import { mfaFormErrorKey } from '../mfaSchema'
import styles from './mfa.module.css'

/**
 * A 6-digit code form (contract 1.7 §6.4–§6.6, §6.12): the device radio with two or more devices,
 * a 16px numeric field with `autocomplete="one-time-code"` (iOS offers the code), one primary
 * button, then whatever the screen adds under it (`children`). Logic in `useVerifyCodeForm`.
 */
export function VerifyCodeForm({
  factors,
  factorId,
  purpose,
  onVerified,
  submitLabel,
  verifyingLabel,
  autoFocus = false,
  children,
}: {
  factors: readonly VerifiedFactor[]
  factorId?: string
  purpose: VerifyPurpose
  onVerified: () => void
  submitLabel: string
  verifyingLabel: string
  autoFocus?: boolean
  children?: ReactNode
}) {
  const { t } = useTranslation('pro')
  const code = useVerifyCodeForm({ factors, factorId, purpose, onVerified })
  const { register, formState } = code.form
  const formError = mfaFormErrorKey(formState.errors.code?.message)
  const errorKey = formError ?? code.error

  return (
    <form className={styles.form} onSubmit={(event) => void code.submit(event)} noValidate>
      {code.choosesDevice && (
        <fieldset className={styles.devices}>
          <legend className={styles.legend}>{t('mfa.challenge.device')}</legend>
          {factors.map((factor) => (
            <label key={factor.id} className={cx(styles.option, 'pressable')}>
              <input type="radio" value={factor.id} {...register('factorId')} />
              <span>{factor.friendlyName || t('security.unnamed')}</span>
            </label>
          ))}
        </fieldset>
      )}
      <TextField
        label={t('mfa.codeLabel')}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={12}
        autoFocus={autoFocus}
        error={errorKey ? t(errorKey) : null}
        {...register('code')}
      />
      <Button type="submit" block disabled={code.verifying}>
        {code.verifying ? verifyingLabel : submitLabel}
      </Button>
      {children}
    </form>
  )
}
