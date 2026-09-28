import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ManageSlot, ManageViewResponse } from '@fn-shared/booking-schemas.ts'
import { toLocalDate, type LocalDate } from '@/shared/lib/localDates'
import { Button } from '@/shared/ui/Button'
import { Skeleton } from '@/shared/ui/Skeleton'
import { DateStrip } from '../components/DateStrip'
import { TimeGrid } from '../components/TimeGrid'
import { formatLongDate, formatShortDate, shortTime } from '../format'
import { dateWindow, groupByDate, WINDOW_DAYS } from '../slots'
import { useManageSlots } from './useManageSlots'
import styles from './ManagePage.module.css'

/**
 * Reschedule from the manage link (the last piece of 1.3, first to cut: C1 #2). Same staff, the
 * booking's own length; the server lists exactly the starts it will accept (`manage_slots`).
 * A chosen time belongs to the day it was chosen on: another day or window drops it, and the
 * button names the day too. After AN001 the times are asked for again.
 */
export function RescheduleView({
  token,
  view,
  pending,
  onMove,
  onKeep,
}: {
  token: string
  view: ManageViewResponse
  pending: boolean
  /** Resolves with the error code of a failed move, null when it moved. */
  onMove: (startsAt: string) => Promise<string | null>
  onKeep: () => void
}) {
  const { t } = useTranslation(['booking', 'common'])
  const { business, appointment } = view
  const [today] = useState(() => toLocalDate(new Date(), business.timezone))
  const [index, setIndex] = useState(0)
  const [date, setDate] = useState<LocalDate | null>(null)
  const [choice, setChoice] = useState<ManageSlot | null>(null)
  // The last day the server may offer is unknown here: a window without slots ends the strip.
  const range = dateWindow(today, index, (index + 1) * WINDOW_DAYS - 1)
  const slots = useManageSlots(token, range.from, range.to)

  const current = Date.parse(appointment.starts_at)
  const free = slots.slots.filter((slot) => Date.parse(slot.starts_at) !== current)
  const byDate = groupByDate(free)
  const shown = date && byDate.has(date) ? date : (range.dates.find((d) => byDate.has(d)) ?? null)
  const picked = choice !== null && choice.local_date === shown ? choice : null

  const showDate = (next: LocalDate) => {
    setDate(next)
    setChoice(null)
  }
  const showWindow = (window: number) => {
    setIndex(window)
    setDate(null)
    setChoice(null)
  }
  const move = async () => {
    if (!picked) return
    if ((await onMove(picked.starts_at)) === 'AN001') {
      setChoice(null)
      slots.refetch()
    }
  }

  return (
    <div className={styles.block}>
      <DateStrip
        dates={range.dates}
        available={new Set(byDate.keys())}
        selected={shown}
        loading={slots.status === 'loading'}
        locale={business.locale}
        onSelect={showDate}
        onEarlier={index > 0 ? () => showWindow(index - 1) : null}
        onLater={free.length > 0 ? () => showWindow(index + 1) : null}
      />
      {slots.status === 'loading' && <Skeleton height={48} shape="pill" />}
      {slots.status === 'error' && (
        <div className={styles.block} role="alert">
          <p>{t('slot.loadError')}</p>
          <Button variant="secondary" onClick={slots.refetch}>
            {t('common:retry')}
          </Button>
        </div>
      )}
      {slots.status === 'ready' && !shown && <p className={styles.muted}>{t('slot.none')}</p>}
      {shown && (
        <TimeGrid
          slots={byDate.get(shown) ?? []}
          selected={picked?.starts_at ?? null}
          label={t('slot.times', { date: formatLongDate(shown, business.locale) })}
          onPick={setChoice}
        />
      )}
      <Button
        liquid
        block
        disabled={!picked || pending}
        aria-busy={pending}
        onClick={() => void move()}
      >
        {pending
          ? t('manage.moving')
          : picked
            ? t('manage.move', {
                date: formatShortDate(picked.local_date, business.locale),
                time: shortTime(picked.local_time),
              })
            : t('manage.rescheduleTitle')}
      </Button>
      <Button variant="secondary" block disabled={pending} onClick={onKeep}>
        {t('manage.keep')}
      </Button>
    </div>
  )
}
