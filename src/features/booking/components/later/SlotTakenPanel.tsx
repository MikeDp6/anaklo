import { useTranslation } from 'react-i18next'
import { addLocalDays } from '@/shared/lib/localDates'
import { Button } from '@/shared/ui/Button'
import { Skeleton } from '@/shared/ui/Skeleton'
import type { BookingFlow } from '../../flow/useBookingFlow'
import { formatLongDate, shortTime } from '../../format'
import { useSlots } from '../../hooks/useSlots'
import { nearestSlots } from '../../slots'
import { TimeGrid } from '../TimeGrid'
import styles from './later.module.css'

const ALTERNATIVES = 4

/**
 * AN001: the chosen time was taken meanwhile. Offers the nearest free times of that day and the
 * next (same service and staff choice) from `available_slots`; tapping one replaces the time and
 * keeps everything already typed. «All times» goes back to the full list.
 */
export function SlotTakenPanel({ flow }: { flow: BookingFlow }) {
  const { t } = useTranslation('booking')
  const { catalogue, state, dispatch, locale } = flow
  const taken = state.takenSlot
  const slots = useSlots(
    taken && state.serviceId
      ? {
          slug: catalogue.business.slug,
          serviceId: state.serviceId,
          staffId: state.staffId,
          from: taken.local_date,
          to: addLocalDays(taken.local_date, 1),
        }
      : null,
  )
  if (!taken) return null
  // The same day first; the next day only when nothing else is free that day.
  const others = slots.slots.filter((slot) => slot.starts_at !== taken.starts_at)
  const sameDay = others.filter((slot) => slot.local_date === taken.local_date)
  const nearby = nearestSlots(sameDay.length > 0 ? sameDay : others, taken.starts_at, ALTERNATIVES)
  const day = nearby[0]?.local_date ?? taken.local_date

  return (
    <div className={styles.alert} role="alert">
      <p>{t('taken.title', { time: shortTime(taken.local_time) })}</p>
      {slots.status === 'loading' && <Skeleton height={48} shape="pill" />}
      {slots.status === 'ready' && nearby.length > 0 && (
        <>
          <span className={styles.status}>{t('taken.body')}</span>
          <TimeGrid
            slots={nearby}
            selected={null}
            label={t('slot.times', { date: formatLongDate(day, locale) })}
            onPick={(slot) => dispatch({ type: 'alternative', slot })}
          />
        </>
      )}
      {slots.status !== 'loading' && nearby.length === 0 && (
        <span className={styles.status}>{t('taken.none')}</span>
      )}
      <Button variant="secondary" onClick={() => dispatch({ type: 'slots' })}>
        {t('taken.all')}
      </Button>
    </div>
  )
}
