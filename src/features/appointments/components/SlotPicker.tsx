import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { dayParts, formatLongDate, formatTime, useAppLocale } from '@/features/calendar/format'
import { useStaffSlots } from '@/features/calendar/hooks/useDayQueries'
import type { Slot } from '@/features/calendar/schema'
import { addLocalDays, type LocalDate } from '@/shared/lib/dates'
import { failureOf, rpcFailureMessageKey } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { Skeleton } from '@/shared/ui/Skeleton'
import { cx } from '@/shared/ui/cx'
import styles from './SlotPicker.module.css'

const WINDOW_DAYS = 5

/**
 * Free times of one staff member from `staff_available_slots` (no online limits), shared by the
 * quick add and the move (contract 1.4 §1.4). A strip of 5 days, then the times of the chosen
 * day. The server re-checks the time on save; AN001 refreshes this list. A chosen time that is not
 * in the list (a gap of «Σήμερα» that starts off the grid) is named above it, so a save never
 * goes to a time the screen does not show.
 */
export function SlotPicker({
  businessId,
  serviceIds,
  staffId,
  excludeAppointmentId = null,
  timeZone,
  today,
  date,
  selected,
  disabled,
  onDateChange,
  onPick,
}: {
  businessId: string
  serviceIds: readonly string[]
  staffId: string
  excludeAppointmentId?: string | null
  /** businesses.timezone: the label of a chosen time that is not in the list. */
  timeZone: string
  /** Business-local today: the strip never goes before it. */
  today: LocalDate
  date: LocalDate
  /** `startsAt` of the chosen slot. */
  selected: string | null
  disabled: boolean
  onDateChange: (date: LocalDate) => void
  onPick: (slot: Slot) => void
}) {
  const { t } = useTranslation(['pro', 'common'])
  const locale = useAppLocale()
  const [windowStart, setWindowStart] = useState(date < today ? today : date)
  const dates = Array.from({ length: WINDOW_DAYS }, (_, index) => addLocalDays(windowStart, index))
  const slots = useStaffSlots(businessId, {
    serviceIds,
    staffId,
    from: date,
    to: date,
    excludeAppointmentId,
  })

  const offList =
    selected !== null &&
    slots.data !== undefined &&
    !slots.data.some((s) => s.startsAt === selected)
      ? selected
      : null

  const shift = (days: number) => {
    const start = addLocalDays(windowStart, days)
    const next = start < today ? today : start
    setWindowStart(next)
    onDateChange(next)
  }

  return (
    <div className={styles.picker}>
      <div className={styles.strip} role="group" aria-label={t('slots.dates')}>
        <button
          type="button"
          className={cx(styles.more, 'pressable')}
          onClick={() => shift(-WINDOW_DAYS)}
          disabled={disabled || windowStart <= today}
          aria-label={t('slots.earlier')}
        >
          ‹
        </button>
        {dates.map((day) => {
          const parts = dayParts(day, locale)
          return (
            <button
              key={day}
              type="button"
              className={cx(styles.day, 'pressable')}
              aria-pressed={day === date}
              aria-label={formatLongDate(day, locale)}
              data-date={day}
              disabled={disabled}
              onClick={() => onDateChange(day)}
            >
              <span className={styles.weekday}>{parts.weekday}</span>
              <span className={styles.number}>{parts.day}</span>
            </button>
          )
        })}
        <button
          type="button"
          className={cx(styles.more, 'pressable')}
          onClick={() => shift(WINDOW_DAYS)}
          disabled={disabled}
          aria-label={t('slots.later')}
        >
          ›
        </button>
      </div>

      {offList !== null && (
        <p className={styles.chosen}>
          {t('slots.chosen', { time: formatTime(offList, timeZone, locale) })}
        </p>
      )}
      {slots.isPending ? (
        <div className={styles.grid} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('common:loading')}
          </span>
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} height={48} shape="pill" />
          ))}
        </div>
      ) : slots.isError ? (
        <div className={styles.message} role="alert">
          <p>{t(rpcFailureMessageKey(failureOf(slots.error), 'read'))}</p>
          <Button variant="secondary" onClick={() => void slots.refetch()}>
            {t('common:retry')}
          </Button>
        </div>
      ) : slots.data.length === 0 ? (
        <p className={styles.message}>{t('slots.none')}</p>
      ) : (
        <div
          className={styles.grid}
          role="group"
          aria-label={t('slots.times', { date: formatLongDate(date, locale) })}
        >
          {slots.data.map((slot) => (
            <button
              key={slot.startsAt}
              type="button"
              className={cx(styles.time, 'pressable')}
              aria-pressed={slot.startsAt === selected}
              data-starts-at={slot.startsAt}
              disabled={disabled}
              onClick={() => onPick(slot)}
            >
              {slot.localTime}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
