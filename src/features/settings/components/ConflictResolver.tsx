import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { NotifyToggle } from '@/features/appointments/components/NotifyToggle'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { formatShortDate, formatTime, useAppLocale } from '@/features/calendar/format'
import { toLocalDate } from '@/shared/lib/dates'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { useConflictResolution } from '../hooks/useConflictResolution'
import type { ScheduleConflict } from '../schema'
import styles from './ConflictResolver.module.css'
import { ReassignChoices } from './ReassignChoices'

/**
 * One appointment that no longer fits the schedule (contract 1.6 §4.9): when, who, why (reason
 * codes only, never a colleague's reason for time off), then «Ανάθεση: …» to a free colleague at
 * the same time (not when the shop is closed), «Ακύρωση με SMS», or the day in the calendar.
 * Results only after the server answered; the row keeps its result on screen.
 */
export function ConflictResolver({
  businessId,
  timeZone,
  conflict,
  staffNames,
  serviceNames,
  onResolved,
}: {
  businessId: string
  timeZone: string
  conflict: ScheduleConflict
  staffNames: ReadonlyMap<string, string>
  serviceNames: ReadonlyMap<string, string>
  onResolved?: (appointmentId: string) => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const resolution = useConflictResolution({ businessId, timeZone, conflict, onResolved })
  const { outcome, failing } = resolution
  const localDate = toLocalDate(new Date(conflict.startsAt), timeZone)
  const time = formatTime(conflict.startsAt, timeZone, locale)
  const client = conflict.clientName ?? t('conflicts.walkIn')
  const services = conflict.serviceIds.map((id) => serviceNames.get(id) ?? '').filter(Boolean)

  return (
    <article className={styles.card} aria-label={`${time} ${client}`}>
      <p className={styles.when}>
        {t('conflicts.when', {
          date: formatShortDate(localDate, locale),
          from: time,
          to: formatTime(conflict.endsAt, timeZone, locale),
        })}
      </p>
      <p className={styles.client}>{client}</p>
      <p className={styles.meta}>
        {[...services, t('conflicts.with', { name: staffNames.get(conflict.staffId) ?? '' })].join(
          ' · ',
        )}
      </p>
      <ul className={styles.chips} aria-label={t('conflicts.reasonsLabel')}>
        {conflict.reasons.map((reason) => (
          <li key={reason} className={styles.chip}>
            {t(`conflicts.reasons.${reason}`)}
          </li>
        ))}
      </ul>
      {outcome ? (
        <div role="status" className={styles.outcome}>
          <p className={styles.outcomeTitle}>
            {outcome.kind === 'moved'
              ? t('conflicts.reassigned', { staff: staffNames.get(outcome.staffId) ?? '' })
              : t('conflicts.cancelled')}
          </p>
          {outcome.smsNote && <p className={styles.muted}>{t(outcome.smsNote)}</p>}
        </div>
      ) : (
        <>
          {!resolution.shopClosed && (
            <ReassignChoices resolution={resolution} staffNames={staffNames} time={time} />
          )}
          <fieldset className={styles.group} disabled={resolution.busy}>
            <legend className={styles.legend}>{t('conflicts.cancelTitle')}</legend>
            {resolution.canNotify && (
              <NotifyToggle
                checked={resolution.cancelNotify}
                disabled={resolution.busy}
                onChange={resolution.setCancelNotify}
              />
            )}
            <Button variant="secondary" onClick={resolution.cancel}>
              {resolution.cancelling
                ? t('conflicts.cancelling')
                : resolution.canNotify && resolution.cancelNotify
                  ? t('conflicts.cancelWithSms')
                  : t('conflicts.cancel')}
            </Button>
          </fieldset>
          {failing && (
            <SaveFailure
              failure={failing.failure}
              locked={failing.locked}
              pending={failing.pending}
              onRetry={failing.retry}
              onClose={resolution.giveUp}
            />
          )}
          <Link to={`/day?date=${localDate}`} className={cx(styles.dayLink, 'pressable')}>
            {t('conflicts.openDay')}
          </Link>
        </>
      )}
    </article>
  )
}
