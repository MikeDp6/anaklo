import { useTranslation } from 'react-i18next'
import { Card } from '@/shared/ui/Card'
import { findService, findStaff, termsFor } from '../../catalogue'
import type { BookingFlow } from '../../flow/useBookingFlow'
import { formatInstantDate, formatInstantTime, formatPrice } from '../../format'
import styles from './later.module.css'

/**
 * What is being booked, before the server confirms it: service, staff, day and time (business
 * zone), price. With «anyone» the price shown is the service's; the server's total is final.
 */
export function AppointmentSummary({ flow }: { flow: BookingFlow }) {
  const { t } = useTranslation('booking')
  const { catalogue, state, locale } = flow
  const { business } = catalogue
  const service = findService(catalogue, state.serviceId)
  const staff = findStaff(catalogue, state.staffId)
  const terms = state.serviceId ? termsFor(catalogue, state.serviceId, state.staffId) : null
  if (!service || !state.slot) return null
  const zone = business.timezone

  return (
    <Card className={styles.summary}>
      <dl className={styles.facts}>
        <div>
          <dt>{t('summary.service')}</dt>
          <dd>{service.name}</dd>
        </div>
        <div>
          <dt>{t('summary.staff')}</dt>
          <dd>{staff?.display_name ?? t('summary.anyStaff')}</dd>
        </div>
        <div>
          <dt>{t('summary.when')}</dt>
          <dd>
            {formatInstantDate(state.slot.starts_at, zone, locale)},{' '}
            {formatInstantTime(state.slot.starts_at, zone, locale)}
          </dd>
        </div>
        {terms && (
          <div>
            <dt>{t('summary.price')}</dt>
            <dd>{formatPrice(terms.price_cents, business.currency, locale)}</dd>
          </div>
        )}
      </dl>
    </Card>
  )
}
