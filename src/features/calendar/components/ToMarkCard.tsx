import { useTranslation } from 'react-i18next'
import { useStatusAction } from '@/features/appointments/hooks/useAppointmentActions'
import { rpcFailureMessageKey } from '@/shared/lib/rpcError'
import { toLocalDate } from '@/shared/lib/dates'
import { Button } from '@/shared/ui/Button'
import { formatShortDate, formatTime, useAppLocale } from '../format'
import type { Workspace } from '../hooks/useWorkspace'
import type { StatusTarget, TodayItem } from '../schema'
import styles from './Today.module.css'

/**
 * «Προς σημείωση»: appointments that ended without a mark (before auto-complete gets to them).
 * «Ήρθε» / «Δεν ήρθε» per row; the row leaves the list only when the server confirmed and
 * «Σήμερα» refetched (no optimistic removal).
 */
export function ToMarkCard({
  workspace,
  count,
  items,
  today,
}: {
  workspace: Workspace
  count: number
  items: readonly TodayItem[]
  today: string
}) {
  const { t } = useTranslation('pro')
  if (count === 0) return null
  return (
    <section className={styles.toMark} aria-labelledby="today-to-mark">
      <h2 id="today-to-mark" className={styles.sectionTitle}>
        {t('today.toMark')}
      </h2>
      <p className={styles.muted}>{t('today.toMarkBody', { count })}</p>
      <ul className={styles.list} role="list">
        {items.map((item) => (
          <ToMarkRow key={item.appointmentId} workspace={workspace} item={item} today={today} />
        ))}
      </ul>
    </section>
  )
}

function ToMarkRow({
  workspace,
  item,
  today,
}: {
  workspace: Workspace
  item: TodayItem
  today: string
}) {
  const { t } = useTranslation(['pro', 'common'])
  const locale = useAppLocale()
  const zone = workspace.business.timeZone
  const action = useStatusAction({ businessId: workspace.businessId, timeZone: zone })
  const date = toLocalDate(new Date(item.startsAt), zone)
  const when =
    date === today
      ? formatTime(item.startsAt, zone, locale)
      : `${formatShortDate(date, locale)} ${formatTime(item.startsAt, zone, locale)}`
  const pendingTarget = action.pending ? action.variables?.status : undefined
  const send = (status: StatusTarget) =>
    action.submit({
      appointmentId: item.appointmentId,
      fromStatus: item.status,
      status,
      startsAt: item.startsAt,
    })
  const label = item.clientName ?? t('appointment.noClient')

  return (
    <li className={styles.markRow}>
      <p className={styles.itemMain}>
        <span className={styles.itemTitle}>{label}</span>
        <span className={styles.muted}>{when}</span>
      </p>
      {action.locked ? (
        // Unknown outcome: only the identical request again (idempotent by target status).
        <Button onClick={action.retry} disabled={action.pending}>
          {action.pending ? t('saving') : t('common:retry')}
        </Button>
      ) : (
        <div className={styles.markActions} role="group" aria-label={label}>
          <Button
            onClick={() => send('completed')}
            disabled={action.pending}
            aria-label={t('today.markCompletedFor', { name: label })}
          >
            {pendingTarget === 'completed' ? t('saving') : t('appointment.actions.complete')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => send('no_show')}
            disabled={action.pending}
            aria-label={t('today.markNoShowFor', { name: label })}
          >
            {pendingTarget === 'no_show' ? t('saving') : t('appointment.actions.noShow')}
          </Button>
        </div>
      )}
      {action.failure && (
        <p role="alert" className={styles.error}>
          {t(rpcFailureMessageKey(action.failure))}
        </p>
      )}
    </li>
  )
}
