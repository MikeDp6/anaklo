import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { newIdempotencyKey } from '@/features/appointments/attemptKey'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { useBusinessToday } from '@/features/calendar/hooks/useBusinessToday'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { Notice } from '@/shared/ui/Notice'
import { groupExceptions } from '../exceptionGroups'
import { useExceptions } from '../hooks/useExceptions'
import type { SettingsFrame } from '../hooks/useSettingsFrame'
import { ClosureItem } from './ClosureItem'
import { ClosureSheet } from './ClosureSheet'
import { ListSkeleton, SettingsScreen } from './SettingsScreen'
import styles from './screens.module.css'

/**
 * /settings/closures (owner, manager; contract 1.6 §4.6). Never cut (plan C1): shop holidays,
 * a staff member's days off and days with other hours, from today on, grouped; one primary
 * action «Νέο κλείσιμο».
 */
export function ClosuresPage() {
  const { t } = useTranslation('pro')
  return (
    <SettingsScreen
      title={t('closures.title')}
      intro={t('closures.intro')}
      loadingLabel={t('closures.loading')}
    >
      {(frame) => <ClosuresList frame={frame} />}
    </SettingsScreen>
  )
}

/** The list of closures from the business-local today on, and the sheet of a new one. */
function ClosuresList({ frame }: { frame: SettingsFrame }) {
  const { t } = useTranslation('pro')
  const today = useBusinessToday(frame.business.timeZone)
  const exceptions = useExceptions(frame.businessId, today)
  // A new sheet per opening (a fresh form; its rows get new ids when saved).
  const [sheet, setSheet] = useState<string | null>(null)
  const retry = () => void exceptions.refetch()

  return (
    <>
      <Button block onClick={() => setSheet(newIdempotencyKey())}>
        {t('closures.add')}
      </Button>
      {failedWithoutData(exceptions) ? (
        <LoadError failure={failureOf(exceptions.error)} onRetry={retry} />
      ) : exceptions.data === undefined ? (
        <ListSkeleton label={t('closures.loading')} />
      ) : (
        <>
          {failedRefresh(exceptions) && (
            <RefreshError failure={failureOf(exceptions.error)} onRetry={retry} />
          )}
          {exceptions.data.length === 0 ? (
            <Notice title={t('closures.emptyTitle')} body={t('closures.empty')} />
          ) : (
            <ul className={styles.list} aria-label={t('closures.listLabel')}>
              {groupExceptions(exceptions.data).map((group) => (
                <ClosureItem
                  key={group.key}
                  businessId={frame.businessId}
                  group={group}
                  scopeName={
                    group.staffId === null
                      ? t('closures.wholeShop')
                      : (frame.staffNames.get(group.staffId) ?? '')
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
      {sheet && (
        <ClosureSheet key={sheet} frame={frame} today={today} onClose={() => setSheet(null)} />
      )}
    </>
  )
}
