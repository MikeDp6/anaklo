import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatShortDate, useAppLocale } from '@/features/calendar/format'
import type { ExceptionGroup } from '../exceptionGroups'
import { useDeleteExceptions } from '../hooks/useExceptions'
import { ConfirmDelete } from './ConfirmDelete'
import { FormFailure } from './FormFailure'
import styles from './screens.module.css'

/**
 * One item of `ClosuresList`: dates, scope, «Κλειστό» or «Ειδικό ωράριο …», the note, and
 * «Διαγραφή» with one confirmation, which deletes every row of the item in one call. The item
 * leaves the list when the list refetches after the server answered.
 */
export function ClosureItem({
  businessId,
  group,
  scopeName,
}: {
  businessId: string
  group: ExceptionGroup
  /** «Όλο το κατάστημα» or the staff member's name. */
  scopeName: string
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const remove = useDeleteExceptions(businessId)
  const [confirming, setConfirming] = useState(false)
  const from = formatShortDate(group.from, locale)
  const dates =
    group.from === group.to
      ? from
      : t('closures.range', { from, to: formatShortDate(group.to, locale) })
  const hours = group.intervals
    .map((interval) => t('closures.interval', { start: interval.start, end: interval.end }))
    .join(' · ')
  const what = group.kind === 'closed' ? t('closures.closed') : t('closures.special', { hours })
  const busy = remove.pending || remove.locked

  return (
    <li className={styles.item}>
      <span className={styles.title}>{dates}</span>
      <span className={styles.meta}>
        {scopeName} · {what}
      </span>
      {group.note && <span className={styles.note}>{group.note}</span>}
      {remove.succeeded ? (
        <p role="status" className={styles.muted}>
          {t('closures.deleted')}
        </p>
      ) : (
        <>
          <FormFailure
            failure={remove.failure}
            locked={remove.locked}
            pending={remove.pending}
            onRetry={remove.retry}
            onClose={() => {
              remove.reset()
              setConfirming(false)
            }}
          />
          {!remove.locked && (
            <ConfirmDelete
              confirming={confirming}
              busy={busy}
              label={t('closures.deleteLabel', { item: `${dates}, ${scopeName}` })}
              onAsk={() => setConfirming(true)}
              onCancel={() => setConfirming(false)}
              onConfirm={() => remove.submit(group.ids)}
            />
          )}
        </>
      )}
    </li>
  )
}
