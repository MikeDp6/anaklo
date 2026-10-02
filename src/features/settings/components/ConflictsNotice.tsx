import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Skeleton } from '@/shared/ui/Skeleton'
import { useScheduleConflicts } from '../hooks/useScheduleConflicts'
import { aheadOf, type ConflictSpan } from '../conflictWindow'
import styles from './screens.module.css'

/**
 * After a closure or a time off was saved (contract 1.6 §4.6, §4.7): how many booked
 * appointments now fall in it, with «Δες τα ραντεβού». Nothing when none (or the span is over).
 */
export function ConflictsNotice({
  businessId,
  span,
  link,
  textKey,
}: {
  businessId: string
  span: ConflictSpan
  /** `/settings/conflicts?…` for the same scope and dates. */
  link: string
  textKey: 'closures.conflicts' | 'timeOff.conflicts'
}) {
  const { t } = useTranslation('pro')
  // Fixed when the notice appears: a key that changed with the clock would refetch forever.
  const [query] = useState(() => aheadOf(span, Date.now()))
  const conflicts = useScheduleConflicts(
    businessId,
    query ?? { staffId: null, from: null, to: null },
    query !== null,
  )
  if (query === null) return null
  if (conflicts.isPending) {
    return (
      <div role="status">
        <span className="visually-hidden">{t('conflicts.loading')}</span>
        <Skeleton height={48} />
      </div>
    )
  }
  // A failed count is no reason to hide the way to the list.
  const count = conflicts.data?.length ?? null
  if (count === 0) return null
  return (
    <div className={styles.callout} role="status">
      {count !== null && <p>{t(textKey, { count })}</p>}
      <Link to={link} className={`${styles.linkButton} pressable`}>
        {t('conflicts.view')}
      </Link>
    </div>
  )
}
