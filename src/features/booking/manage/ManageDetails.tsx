import { useTranslation } from 'react-i18next'
import type { ManageViewResponse } from '@fn-shared/booking-schemas.ts'
import { Card } from '@/shared/ui/Card'
import { formatInstantDate, formatInstantTime, formatPrice } from '../format'
import styles from './ManagePage.module.css'

/** The appointment of a manage link: day, time, services, staff and price (business zone). */
export function ManageDetails({ view }: { view: ManageViewResponse }) {
  const { t } = useTranslation('booking')
  const { business, appointment } = view
  const zone = business.timezone
  const locale = business.locale
  const cancelled = appointment.status === 'cancelled'

  return (
    <Card>
      {cancelled && <p className={styles.badge}>{t('manage.cancelledStatus')}</p>}
      <dl className={styles.facts} data-cancelled={cancelled}>
        <div>
          <dt>{formatInstantDate(appointment.starts_at, zone, locale)}</dt>
          <dd>{formatInstantTime(appointment.starts_at, zone, locale)}</dd>
        </div>
        {appointment.services.map((service) => (
          <div key={service.id}>
            <dt>{service.name}</dt>
            <dd>{t('units.minutes', { count: service.duration_min })}</dd>
          </div>
        ))}
        <div>
          <dt>{t('summary.staff')}</dt>
          <dd>{appointment.staff.display_name}</dd>
        </div>
        <div>
          <dt>{t('summary.price')}</dt>
          <dd>{formatPrice(appointment.total_cents, business.currency, locale)}</dd>
        </div>
      </dl>
      {business.address && <p className={styles.muted}>{business.address}</p>}
    </Card>
  )
}
