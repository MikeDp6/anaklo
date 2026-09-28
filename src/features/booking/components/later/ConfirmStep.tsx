import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Card } from '@/shared/ui/Card'
import { ConfirmMark } from '@/shared/ui/ConfirmMark'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { cx } from '@/shared/ui/cx'
import { findService, findStaff } from '../../catalogue'
import type { BookingFlow } from '../../flow/useBookingFlow'
import { formatInstantDate, formatInstantTime, formatPrice } from '../../format'
import { Reveal } from '../Reveal'
import { ConfirmLinks } from './ConfirmLinks'
import styles from './later.module.css'

/**
 * The confirmation, shown only after `book` answered (rule 14): E15 mark, the booked day, time,
 * staff and price as the server returned them, the next-visit hint, and the manage link,
 * calendar, map and «book again» actions.
 */
export function ConfirmStep({ flow }: { flow: BookingFlow }) {
  const { t } = useTranslation('booking')
  const { catalogue, state, locale } = flow
  const section = useRef<HTMLElement>(null)
  useEffect(() => section.current?.focus({ preventScroll: true }), [])
  const result = state.booking
  if (!result) return null
  const { business } = catalogue
  const { appointment } = result
  const zone = business.timezone
  const service = findService(catalogue, state.serviceId)
  const staff = findStaff(catalogue, appointment.staff_id)
  const date = formatInstantDate(appointment.starts_at, zone, locale)
  const time = formatInstantTime(appointment.starts_at, zone, locale)
  const hint = result.next_visit_hint

  return (
    <section
      ref={section}
      tabIndex={-1}
      className={cx(styles.done, 'step-enter')}
      aria-label={t('done.title')}
    >
      <ConfirmMark label={t('done.title')} />
      <Eyebrow>{t('done.eyebrow')}</Eyebrow>
      <DisplayTitle as="h2" size="lg">
        {t('done.title')}
      </DisplayTitle>
      <Reveal className={styles.links}>
        <Card className={styles.summary}>
          <dl className={styles.facts}>
            <div>
              <dt>{date}</dt>
              <dd>{time}</dd>
            </div>
            {service && (
              <div>
                <dt>{service.name}</dt>
                <dd>{formatPrice(appointment.total_cents, business.currency, locale)}</dd>
              </div>
            )}
            {staff && (
              <div>
                <dt>{t('summary.staff')}</dt>
                <dd>{staff.display_name}</dd>
              </div>
            )}
          </dl>
        </Card>
        <p className={styles.status}>{t('done.sms')}</p>
        {hint && <p className={styles.hint}>{t(hint.key, { count: hint.weeks })}</p>}
      </Reveal>
      <ConfirmLinks flow={flow} serviceName={service?.name ?? ''} />
    </section>
  )
}
