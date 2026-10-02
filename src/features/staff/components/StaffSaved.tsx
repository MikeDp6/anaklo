import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { Skeleton } from '@/shared/ui/Skeleton'
import { useStaffConflictCount } from '../hooks/useStaffConflictCount'
import styles from './settings.module.css'

/**
 * After the server answered a staff save (contract 1.6 §4.4): a new staff member → links to their
 * hours and to the services; a deactivation → how many future appointments need a change, with
 * «Δες τα ραντεβού».
 */
export function StaffSaved({
  businessId,
  staffId,
  created,
  deactivated,
  onDone,
}: {
  businessId: string
  staffId: string
  created: boolean
  deactivated: boolean
  onDone: () => void
}) {
  const { t } = useTranslation('pro')
  return (
    <div className={styles.stack}>
      <p role="status" className={styles.rowTitle}>
        {t(created ? 'staffSettings.created' : 'staffSettings.saved')}
      </p>
      {created && (
        <>
          <p className={styles.muted}>{t('staffSettings.next')}</p>
          <div className={styles.links}>
            <Link
              to={`/settings/hours?staff=${staffId}`}
              className={cx(styles.linkButton, 'pressable')}
            >
              {t('staffSettings.toHours')}
            </Link>
            <Link to="/settings/services" className={cx(styles.linkButton, 'pressable')}>
              {t('staffSettings.toServices')}
            </Link>
          </div>
        </>
      )}
      {deactivated && <DeactivationConflicts businessId={businessId} staffId={staffId} />}
      <Button block onClick={onDone}>
        {t('sheet.done')}
      </Button>
    </div>
  )
}

function DeactivationConflicts({ businessId, staffId }: { businessId: string; staffId: string }) {
  const { t } = useTranslation('pro')
  const count = useStaffConflictCount(businessId, staffId, true)
  const link = (
    <Link
      to={`/settings/conflicts?staff=${staffId}`}
      className={cx(styles.linkButton, 'pressable')}
    >
      {t('staffSettings.seeConflicts')}
    </Link>
  )
  // The count did not load: the list itself still tells.
  if (count.data === undefined && count.isError) return link
  if (count.data === undefined) {
    return (
      <p role="status" aria-busy="true">
        <span className="visually-hidden">{t('staffSettings.conflictsLoading')}</span>
        <Skeleton height={22} width="80%" />
      </p>
    )
  }
  if (count.data === 0) return <p className={styles.muted}>{t('staffSettings.noConflicts')}</p>
  return (
    <div className={cx(styles.warning, styles.stack)}>
      <p>{t('staffSettings.conflicts', { count: count.data })}</p>
      {link}
    </div>
  )
}
