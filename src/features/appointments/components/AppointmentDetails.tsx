import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { formatLongDate, formatPrice, formatTime, useAppLocale } from '@/features/calendar/format'
import type { Workspace } from '@/features/calendar/hooks/useWorkspace'
import type { DayAppointment } from '@/features/calendar/schema'
import { toLocalDate } from '@/shared/lib/dates'
import { formatPhone } from '@/shared/lib/phone'
import { ButtonLink } from '@/shared/ui/ButtonLink'
import { cx } from '@/shared/ui/cx'
import styles from './AppointmentDetails.module.css'

/**
 * Who, when, with whom, what and how much (the member may read it: RLS returned it), and a link
 * to the client's card (contract 1.8 §4.10: the barber reads the notes before the cut).
 */
export function AppointmentDetails({
  appointment,
  workspace,
}: {
  appointment: DayAppointment
  workspace: Workspace
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const { business } = workspace
  const zone = business.timeZone
  const staffName =
    workspace.staff.find((member) => member.id === appointment.staffId)?.displayName ?? ''
  const serviceNames = appointment.services.map(
    (line) =>
      workspace.services.find((service) => service.id === line.serviceId)?.name ??
      t('appointment.unknownService'),
  )
  const { client } = appointment
  const phone = client?.phoneE164 ?? null

  return (
    <div className={styles.details}>
      <p className={styles.status} data-status={appointment.status}>
        {t(`appointment.status.${appointment.status}`)}
      </p>
      <p className={styles.client}>{appointment.client?.fullName ?? t('appointment.noClient')}</p>
      <dl className={styles.list}>
        <div>
          <dt>{t('appointment.when')}</dt>
          <dd>
            {formatLongDate(toLocalDate(new Date(appointment.startsAt), zone), locale)}
            {' · '}
            {t('appointment.timeRange', {
              from: formatTime(appointment.startsAt, zone, locale),
              to: formatTime(appointment.endsAt, zone, locale),
            })}
          </dd>
        </div>
        <div>
          <dt>{t('appointment.staff')}</dt>
          <dd>{staffName}</dd>
        </div>
        <div>
          <dt>{t('appointment.services')}</dt>
          <dd>{serviceNames.join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>{t('appointment.total')}</dt>
          <dd>{formatPrice(appointment.totalCents, business.currency, locale)}</dd>
        </div>
        <div>
          <dt>{t('appointment.source')}</dt>
          <dd>{t(`appointment.sources.${appointment.source}`)}</dd>
        </div>
      </dl>
      {phone && (
        <ButtonLink href={`tel:${phone}`} block>
          {t('appointment.call', { phone: formatPhone(phone) })}
        </ButtonLink>
      )}
      {client && (
        <Link to={`/clients/${client.id}`} className={cx(styles.cardLink, 'pressable')}>
          {t('appointment.clientCard')}
        </Link>
      )}
    </div>
  )
}
