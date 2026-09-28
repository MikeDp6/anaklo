import { useTranslation } from 'react-i18next'
import { useSignOut } from '../hooks/useSignOut'
import styles from './SignOutButton.module.css'

/** Signs out this device only (ADR-0009 §19). */
export function SignOutButton() {
  const { t } = useTranslation('pro')
  const { signOut, pending } = useSignOut()
  return (
    <button type="button" className={styles.button} onClick={signOut} disabled={pending}>
      {pending ? t('signingOut') : t('signOut')}
    </button>
  )
}
