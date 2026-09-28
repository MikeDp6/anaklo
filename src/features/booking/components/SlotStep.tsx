import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toLocalDate } from '@/shared/lib/localDates'
import { Button } from '@/shared/ui/Button'
import { Skeleton } from '@/shared/ui/Skeleton'
import type { BookingFlow } from '../flow/useBookingFlow'
import { formatLongDate } from '../format'
import { useErrorText } from '../hooks/useErrorText'
import { useSlots } from '../hooks/useSlots'
import { dateWindow, groupByDate } from '../slots'
import { DateStrip } from './DateStrip'
import { prefetchLaterSteps } from './laterSteps'
import { StepSection } from './StepSection'
import { TimeGrid } from './TimeGrid'
import styles from './steps.module.css'

/** Step 3: a date strip and the free times of the chosen day, in the business zone. */
export function SlotStep({ flow }: { flow: BookingFlow }) {
  const { t } = useTranslation(['booking', 'common'])
  const errorText = useErrorText()
  const { catalogue, state, dispatch, locale } = flow
  const { business } = catalogue
  const [today] = useState(() => toLocalDate(new Date(), business.timezone))
  const range = dateWindow(today, state.window, business.max_advance_days)
  const slots = useSlots(
    state.serviceId
      ? {
          slug: business.slug,
          serviceId: state.serviceId,
          staffId: state.staffId,
          from: range.from,
          to: range.to,
        }
      : null,
  )
  const byDate = groupByDate(slots.slots)
  const firstFree = range.dates.find((date) => byDate.has(date)) ?? null
  const date = state.date && byDate.has(state.date) ? state.date : firstFree
  const times = date ? (byDate.get(date) ?? []) : []

  const moveWindow = (window: number) => dispatch({ type: 'window', window })

  return (
    <StepSection direction={state.direction} eyebrow={t('slot.eyebrow')} title={t('slot.title')}>
      <DateStrip
        dates={range.dates}
        available={new Set(byDate.keys())}
        selected={date}
        loading={slots.status === 'loading'}
        locale={locale}
        onSelect={(selected) => dispatch({ type: 'date', date: selected })}
        onEarlier={range.hasEarlier ? () => moveWindow(state.window - 1) : null}
        onLater={range.hasLater ? () => moveWindow(state.window + 1) : null}
      />
      {slots.status === 'loading' && (
        <div className={styles.row} aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} height={48} width={80} shape="pill" />
          ))}
        </div>
      )}
      {slots.status === 'error' && (
        <div className={styles.group} role="alert">
          <p>{t('slot.loadError')}</p>
          <p className={styles.empty}>{errorText('network')}</p>
          <Button variant="secondary" onClick={slots.retry}>
            {t('common:retry')}
          </Button>
        </div>
      )}
      {slots.status === 'ready' && !date && <p className={styles.empty}>{t('slot.none')}</p>}
      {slots.status === 'ready' && date && (
        <TimeGrid
          slots={times}
          selected={state.slot?.starts_at ?? null}
          label={t('slot.times', { date: formatLongDate(date, locale) })}
          onPick={(slot) => {
            prefetchLaterSteps()
            dispatch({ type: 'slot', slot })
          }}
        />
      )}
    </StepSection>
  )
}
