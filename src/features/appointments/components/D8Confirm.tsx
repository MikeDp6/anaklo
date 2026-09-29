import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import type { D8Flag } from '../rules'
import styles from './forms.module.css'

/**
 * The server said the time is outside the hours (AN005) or inside a buffer (AN006): staff may
 * still book it after confirming. Confirming is a NEW attempt (the flag is part of the payload,
 * so it gets a new idempotency key).
 */
export function D8Confirm({
  flag,
  pending,
  onConfirm,
}: {
  flag: D8Flag
  pending: boolean
  onConfirm: () => void
}) {
  const { t } = useTranslation('pro')
  return (
    <div className={styles.warning} role="alert">
      <div className={styles.stack}>
        <p>{t(`d8.question.${flag}`)}</p>
        <Button onClick={onConfirm} disabled={pending} block>
          {pending ? t('saving') : t(`d8.confirm.${flag}`)}
        </Button>
      </div>
    </div>
  )
}
