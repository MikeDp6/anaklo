import { useTranslation } from 'react-i18next'
import { WalkInButton } from '@/features/appointments/components/WalkInButton'
import { hourMarks, nowOffset, visibleRange } from '../dayLayout'
import { formatTime, useAppLocale } from '../format'
import type { Workspace } from '../hooks/useWorkspace'
import type { DayAppointment, DayFrame } from '../schema'
import { DayColumn, PX_PER_MINUTE, type DayColumnModel } from './DayColumn'
import styles from './DayView.module.css'

/**
 * The day as a CSS grid: a time gutter and one column per chosen staff member (1–2 on a phone).
 * Time → px from real elapsed minutes (dayLayout.ts), so 23- and 25-hour days are drawn as they
 * happen; no calendar library.
 */
export function DayView({
  workspace,
  frame,
  columns,
  now,
  isToday,
  onOpen,
  onWalkIn,
}: {
  workspace: Workspace
  frame: DayFrame
  columns: readonly DayColumnModel[]
  now: Date
  isToday: boolean
  onOpen: (appointment: DayAppointment) => void
  /** Today only: a walk-in for the column's staff member (the page opens the sheet). */
  onWalkIn: (staffId: string) => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const zone = frame.timeZone
  const instants = columns.flatMap((column) => [
    ...column.windows.flatMap((window) => [window.startsAt, window.endsAt]),
    ...(column.readable ? (column.appointments ?? []) : column.blocks).flatMap((item) => [
      item.startsAt,
      item.endsAt,
    ]),
  ])
  const range = visibleRange({
    localDate: frame.localDate,
    timeZone: zone,
    dayStart: frame.dayStart,
    dayEnd: frame.dayEnd,
    instants: isToday ? [...instants, now] : instants,
  })
  const marks = hourMarks(frame.dayStart, zone, range)
  const nowTop = isToday ? nowOffset(now, frame.dayStart, range) : null
  const px = (minutes: number) => `${minutes * PX_PER_MINUTE}px`

  return (
    <div
      className={styles.view}
      style={{ '--columns': columns.length, '--hour': px(60) }}
      data-testid="day-view"
    >
      <div className={styles.head}>
        <span aria-hidden="true" />
        {columns.map((column) => (
          <div key={column.staff.id} className={styles.colHead}>
            <span className={styles.colName}>
              <span
                className={styles.dot}
                style={{ '--staff-color': column.staff.color ?? undefined }}
                aria-hidden="true"
              />
              {column.staff.displayName}
            </span>
            {isToday && <WalkInButton staff={column.staff} compact onOpen={onWalkIn} />}
          </div>
        ))}
      </div>
      <div className={styles.body} style={{ height: px(range.toMin - range.fromMin) }}>
        <div className={styles.gutter} aria-hidden="true">
          {marks.map((mark, index) => (
            <span
              key={`${mark.minute}-${index}`}
              className={styles.hour}
              style={{ top: px(mark.minute - range.fromMin) }}
            >
              {mark.label}
            </span>
          ))}
        </div>
        {columns.map((column) => (
          <DayColumn
            key={column.staff.id}
            column={column}
            frame={frame}
            range={range}
            workspace={workspace}
            onOpen={onOpen}
          />
        ))}
        {nowTop !== null && (
          <div
            className={styles.now}
            style={{ top: px(nowTop) }}
            role="img"
            aria-label={t('day.nowAt', { time: formatTime(now, zone, locale) })}
          />
        )}
      </div>
    </div>
  )
}
