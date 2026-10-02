import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { newIdempotencyKey } from '@/features/appointments/attemptKey'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { formatShortDate, useAppLocale } from '@/features/calendar/format'
import { useBusinessToday } from '@/features/calendar/hooks/useBusinessToday'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { Notice } from '@/shared/ui/Notice'
import type { SettingsFrame } from '../hooks/useSettingsFrame'
import { useTimeOff } from '../hooks/useTimeOff'
import type { TimeOffTarget } from '../hooks/useTimeOffForm'
import type { TimeOff } from '../schema'
import { timeOffSpan } from '../timeOffRange'
import { ListSkeleton, SettingsScreen } from './SettingsScreen'
import { TimeOffSheet } from './TimeOffSheet'
import styles from './screens.module.css'

/**
 * /settings/time-off (owner, manager; contract 1.6 §4.7): current and future time off by start,
 * one primary action «Νέα άδεια»; a row opens its sheet.
 */
export function TimeOffPage() {
  const { t } = useTranslation('pro')
  return (
    <SettingsScreen
      title={t('timeOff.title')}
      intro={t('timeOff.intro')}
      loadingLabel={t('timeOff.loading')}
    >
      {(frame) => <TimeOffList frame={frame} />}
    </SettingsScreen>
  )
}

function TimeOffList({ frame }: { frame: SettingsFrame }) {
  const { t } = useTranslation('pro')
  const today = useBusinessToday(frame.business.timeZone)
  const timeOff = useTimeOff(frame.businessId)
  const [sheet, setSheet] = useState<TimeOffTarget | null>(null)
  const retry = () => void timeOff.refetch()

  return (
    <>
      <Button block onClick={() => setSheet({ kind: 'new', id: newIdempotencyKey() })}>
        {t('timeOff.add')}
      </Button>
      {failedWithoutData(timeOff) ? (
        <LoadError failure={failureOf(timeOff.error)} onRetry={retry} />
      ) : timeOff.data === undefined ? (
        <ListSkeleton label={t('timeOff.loading')} />
      ) : (
        <>
          {failedRefresh(timeOff) && (
            <RefreshError failure={failureOf(timeOff.error)} onRetry={retry} />
          )}
          {timeOff.data.length === 0 ? (
            <Notice title={t('timeOff.emptyTitle')} body={t('timeOff.empty')} />
          ) : (
            <ul className={styles.list} aria-label={t('timeOff.listLabel')}>
              {timeOff.data.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={cx(styles.rowButton, 'pressable')}
                    onClick={() => setSheet({ kind: 'edit', timeOff: row })}
                  >
                    <span className={styles.title}>{frame.staffNames.get(row.staffId) ?? ''}</span>
                    <span className={styles.meta}>
                      {t(`timeOff.reasons.${row.reason}`)} ·{' '}
                      <TimeOffRange timeOff={row} timeZone={frame.business.timeZone} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {sheet && (
        <TimeOffSheet
          key={sheet.kind === 'new' ? sheet.id : sheet.timeOff.id}
          frame={frame}
          today={today}
          target={sheet}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  )
}

/** «Τρί 6 Οκτ – Παρ 9 Οκτ», «Τρί 6 Οκτ, 10:00–13:30» or two dates with times, business-local. */
function TimeOffRange({ timeOff, timeZone }: { timeOff: TimeOff; timeZone: string }) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const span = timeOffSpan(timeOff, timeZone)
  const date = (value: string) => formatShortDate(value, locale)
  switch (span.kind) {
    case 'days':
      return span.from === span.to
        ? date(span.from)
        : t('timeOff.rangeDays', { from: date(span.from), to: date(span.to) })
    case 'times':
      return t('timeOff.rangeTimes', { date: date(span.date), from: span.from, to: span.to })
    case 'instants':
      return t('timeOff.rangeInstants', {
        from: `${date(span.fromDate)} ${span.fromTime}`,
        to: `${date(span.toDate)} ${span.toTime}`,
      })
  }
}
