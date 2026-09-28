import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import type { LoginFormError } from '../hooks/useLoginFlow'
import type { LoginMessageKey } from '../loginErrors'
import styles from './LoginPage.module.css'

export function EmailStep({
  message,
  formError,
  sending,
  onSubmit,
}: {
  message: LoginMessageKey | null
  formError: LoginFormError | null
  sending: boolean
  onSubmit: (email: string) => void
}) {
  const { t } = useTranslation()
  const inputId = useId()
  const errorId = useId()
  const [email, setEmail] = useState('')
  const error = formError ?? message

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(email)
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <p className={styles.lead}>{t('pro.login.intro')}</p>
      <div className={styles.field}>
        <label htmlFor={inputId} className={styles.label}>
          {t('pro.login.emailLabel')}
        </label>
        <input
          id={inputId}
          className={styles.input}
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={formError !== null}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
      <Button type="submit" disabled={sending}>
        {sending ? t('pro.login.sendingCode') : t('pro.login.sendCode')}
      </Button>
    </form>
  )
}
