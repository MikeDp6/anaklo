import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Notice } from '@/shared/ui/Notice'
import { conflictWindow, isPastWindow, readConflictParams } from '../conflictWindow'
import { useServiceNames } from '../hooks/useServiceNames'
import type { SettingsFrame } from '../hooks/useSettingsFrame'
import { ConflictList } from './ConflictList'
import { SettingsScreen } from './SettingsScreen'
import styles from './screens.module.css'

/**
 * /settings/conflicts?staff=&from=&to= (owner, manager; contract 1.6 §4.9): «Ραντεβού που
 * χρειάζονται αλλαγή» after new hours, a closure, a time off or a deactivation. Without dates:
 * from now to the server's 366-day horizon.
 */
export function ConflictsPage() {
  const { t } = useTranslation('pro')
  return (
    <SettingsScreen
      title={t('conflicts.title')}
      intro={t('conflicts.intro')}
      loadingLabel={t('conflicts.loading')}
    >
      {(frame) => <Conflicts frame={frame} />}
    </SettingsScreen>
  )
}

function Conflicts({ frame }: { frame: SettingsFrame }) {
  const { t } = useTranslation('pro')
  const [search] = useSearchParams()
  const serviceNames = useServiceNames(frame.businessId)
  // «Now» of the window, fixed while the screen is open: a key that followed the clock would
  // start a new query every minute (refetch on focus keeps the list fresh).
  const [now] = useState(() => new Date())
  const query = conflictWindow(readConflictParams(search), now, frame.business.timeZone)
  const emptyNotice = <Notice title={t('conflicts.emptyTitle')} body={t('conflicts.empty')} />

  return (
    <ConflictList
      businessId={frame.businessId}
      timeZone={frame.business.timeZone}
      query={query}
      enabled={!isPastWindow(query, now)}
      staffNames={frame.staffNames}
      serviceNames={serviceNames}
      empty={emptyNotice}
      done={
        <p role="status" className={styles.status}>
          {t('absence.allResolved')}
        </p>
      }
    />
  )
}
