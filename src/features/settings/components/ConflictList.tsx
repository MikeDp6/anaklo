import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { failureOf } from '@/shared/lib/rpcError'
import { allResolved, withResolved } from '../conflictRows'
import { useScheduleConflicts } from '../hooks/useScheduleConflicts'
import type { ConflictsQuery, ScheduleConflict } from '../schema'
import { ConflictResolver } from './ConflictResolver'
import { ListSkeleton } from './SettingsScreen'
import styles from './screens.module.css'

/**
 * The appointments of a window that need a change, one `ConflictResolver` each (contract 1.6
 * §4.9, §4.10). Rows resolved here keep their result after the list refetches without them;
 * once every listed row has one, `done` is shown.
 */
export function ConflictList({
  businessId,
  timeZone,
  query,
  enabled = true,
  staffNames,
  serviceNames,
  empty,
  done,
}: {
  businessId: string
  timeZone: string
  query: ConflictsQuery
  enabled?: boolean
  staffNames: ReadonlyMap<string, string>
  serviceNames: ReadonlyMap<string, string>
  /** Shown when nothing is affected. */
  empty: ReactNode
  /** Shown when every listed row was resolved on this screen. */
  done: ReactNode
}) {
  const { t } = useTranslation('pro')
  const conflicts = useScheduleConflicts(businessId, query, enabled)
  const [resolved, setResolved] = useState<ReadonlyMap<string, ScheduleConflict>>(new Map())
  const retry = () => void conflicts.refetch()

  if (!enabled) return empty
  if (failedWithoutData(conflicts)) {
    return <LoadError failure={failureOf(conflicts.error)} onRetry={retry} />
  }
  if (conflicts.data === undefined) return <ListSkeleton label={t('conflicts.loading')} />
  const shown = withResolved(conflicts.data, resolved)
  const resolve = (row: ScheduleConflict) =>
    setResolved((current) => new Map(current).set(row.appointmentId, row))

  return (
    <>
      {failedRefresh(conflicts) && (
        <RefreshError failure={failureOf(conflicts.error)} onRetry={retry} />
      )}
      {shown.length === 0 ? (
        empty
      ) : (
        <ul className={styles.list} aria-label={t('conflicts.listLabel')}>
          {shown.map((row) => (
            <li key={row.appointmentId}>
              <ConflictResolver
                businessId={businessId}
                timeZone={timeZone}
                conflict={row}
                staffNames={staffNames}
                serviceNames={serviceNames}
                onResolved={() => resolve(row)}
              />
            </li>
          ))}
        </ul>
      )}
      {allResolved(shown, resolved) && done}
    </>
  )
}
