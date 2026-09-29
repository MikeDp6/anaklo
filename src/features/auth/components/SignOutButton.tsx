import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { useSignOut } from '../hooks/useSignOut'

/** Signs out this device only (ADR-0009 §19). A secondary G3 pill (E16 press, E2 with a mouse). */
export function SignOutButton() {
  const { t } = useTranslation('pro')
  const { signOut, pending } = useSignOut()
  return (
    <Button variant="secondary" onClick={signOut} disabled={pending}>
      {pending ? t('signingOut') : t('signOut')}
    </Button>
  )
}
