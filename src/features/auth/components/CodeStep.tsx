import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import type { LoginFormError } from '../hooks/useLoginFlow'
import type { LoginMessageKey } from '../loginErrors'
import { normaliseCode } from '../schema'
import styles from './LoginPage.module.css'

export function CodeStep({
  email,
  message,
  formError,
  verifying,
  sending,
  onSubmit,
  onResend,
  onChangeEmail,
}: {
  email: string
  message: LoginMessageKey | null
  formError: LoginFormError | null
  verifying: boolean
  sending: boolean
  onSubmit: (code: string) => void
  onResend: () => void
  onChangeEmail: () => void
}) {
  const { t } = useTranslation()
  const inputId = useId()
  const errorId = useId()
  const [code, setCode] = useState('')
  const neutral = message === 'pro.login.codeSentNeutral'
  const error = formError ?? (neutral ? null : message)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(code)
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <div role="status" className={styles.sent}>
        {neutral && <p>{t('pro.login.codeSentNeutral')}</p>}
        <p className={styles.muted}>{t('pro.login.codeFor', { email })}</p>
        <p className={styles.muted}>{t('pro.login.codeHint')}</p>
      </div>
      <div className={styles.field}>
        <label htmlFor={inputId} className={styles.label}>
          {t('pro.login.codeLabel')}
        </label>
        <input
          id={inputId}
          className={`${styles.input} ${styles.code}`}
          type="text"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          required
          value={code}
          onChange={(event) => setCode(normaliseCode(event.target.value))}
          aria-invalid={formError !== null}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
      <Button type="submit" disabled={verifying}>
        {verifying ? t('pro.login.verifying') : t('pro.login.verify')}
      </Button>
      <div className={styles.secondaryActions}>
        <button type="button" className={styles.link} onClick={onResend} disabled={sending}>
          {t('pro.login.resend')}
        </button>
        <button type="button" className={styles.link} onClick={onChangeEmail}>
          {t('pro.login.changeEmail')}
        </button>
      </div>
    </form>
  )
}
