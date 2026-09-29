import { useTranslation } from 'react-i18next'
import { Skeleton } from '@/shared/ui/Skeleton'
import { cx } from '@/shared/ui/cx'
import { layoutColumn, minutesBetween, type DayRange } from '../dayLayout'
import { formatTime, useAppLocale } from '../format'
import type { Workspace } from '../hooks/useWorkspace'
import { serviceNamesOf } from '../labels'
import type { BusyBlock, DayAppointment, DayFrame, WorkingWindow } from '../schema'
import type { StaffMember } from '@/features/staff/schema'
import styles from './DayView.module.css'

export interface DayColumnModel {
  readonly staff: StaffMember
  /** Read with RLS (own column, or any for owner/manager); otherwise drawn from busy blocks. */
  readonly readable: boolean
  /** null while loading. */
  readonly appointments: readonly DayAppointment[] | null
  readonly blocks: readonly BusyBlock[]
  readonly windows: readonly WorkingWindow[]
}

/** Minutes → px of the day view (1 hour = 96px). */
export const PX_PER_MINUTE = 1.6
/**
 * The shortest drawn item: 30′ = 48px, so the button inside its 1px-padded slot stays ≥ 44px
 * tall (CLAUDE.md: buttons ≥ 44px) also for a 15′ beard trim. layoutColumn counts this drawn
 * height as the item's extent, so a short item and the next one share the width in lanes instead
 * of covering each other.
 */
export const MIN_ITEM_MINUTES = 30

/** One staff member's column: working windows, then appointments (or colleagues' busy blocks). */
export function DayColumn({
  column,
  frame,
  range,
  workspace,
  onOpen,
}: {
  column: DayColumnModel
  frame: DayFrame
  range: DayRange
  workspace: Workspace
  onOpen: (appointment: DayAppointment) => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const zone = frame.timeZone
  const px = (minutes: number) => `${minutes * PX_PER_MINUTE}px`
  const span = (from: string, to: string) =>
    t('appointment.timeRange', {
      from: formatTime(from, zone, locale),
      to: formatTime(to, zone, locale),
    })

  const windows = column.windows.map((window) => {
    const start = Math.max(range.fromMin, minutesBetween(frame.dayStart, window.startsAt))
    const end = Math.min(range.toMin, minutesBetween(frame.dayStart, window.endsAt))
    return { key: window.startsAt, top: start - range.fromMin, height: Math.max(0, end - start) }
  })

  return (
    <div className={styles.column} role="list" aria-label={column.staff.displayName}>
      {windows.map((window) => (
        <span
          key={window.key}
          className={styles.window}
          style={{ top: px(window.top), height: px(window.height) }}
          aria-hidden="true"
        />
      ))}
      {column.readable && column.appointments === null && (
        <div className={styles.columnLoading} aria-hidden="true">
          <Skeleton height={px(45)} shape="control" />
          <Skeleton height={px(30)} shape="control" />
        </div>
      )}
      {column.readable &&
        column.appointments &&
        layoutColumn(column.appointments, frame.dayStart, range, MIN_ITEM_MINUTES).map((placed) => {
          const appointment = placed.item
          const name = appointment.client?.fullName ?? t('appointment.noClient')
          const services = serviceNamesOf(
            workspace,
            appointment.services.map((line) => line.serviceId),
          )
          const when = span(appointment.startsAt, appointment.endsAt)
          return (
            <div
              key={appointment.id}
              role="listitem"
              className={styles.slot}
              style={{
                top: px(placed.top),
                height: px(placed.height),
                left: `${(placed.lane / placed.lanes) * 100}%`,
                width: `${100 / placed.lanes}%`,
              }}
            >
              <button
                type="button"
                className={cx(styles.appointment, 'pressable')}
                data-status={appointment.status}
                style={{ '--staff-color': column.staff.color ?? undefined }}
                aria-label={[
                  `${when} ${name}`,
                  services,
                  t(`appointment.status.${appointment.status}`),
                ]
                  .filter(Boolean)
                  .join(', ')}
                onClick={() => onOpen(appointment)}
              >
                <span className={styles.apptTime}>
                  {formatTime(appointment.startsAt, zone, locale)}
                </span>
                <span className={styles.apptName}>{name}</span>
                <span className={styles.apptMeta}>{services}</span>
              </button>
            </div>
          )
        })}
      {!column.readable &&
        layoutColumn(
          column.blocks.map((block) => ({ ...block, id: block.appointmentId })),
          frame.dayStart,
          range,
          MIN_ITEM_MINUTES,
        ).map((placed) => (
          <div
            key={placed.item.id}
            role="listitem"
            className={cx(styles.slot, styles.busy)}
            style={{
              top: px(placed.top),
              height: px(placed.height),
              left: `${(placed.lane / placed.lanes) * 100}%`,
              width: `${100 / placed.lanes}%`,
            }}
            aria-label={`${span(placed.item.startsAt, placed.item.endsAt)} ${t('day.busy')}`}
          >
            <span aria-hidden="true">{t('day.busy')}</span>
          </div>
        ))}
    </div>
  )
}
