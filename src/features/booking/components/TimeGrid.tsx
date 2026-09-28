import { cx } from '@/shared/ui/cx'
import { shortTime } from '../format'
import styles from './TimeGrid.module.css'

export interface TimeOption {
  starts_at: string
  local_time: string
}

/** The free times of one day as pill buttons. `label` names the group (the day), from i18n. */
export function TimeGrid<T extends TimeOption>({
  slots,
  selected,
  label,
  onPick,
}: {
  slots: readonly T[]
  selected: string | null
  label: string
  onPick: (slot: T) => void
}) {
  return (
    <div className={styles.grid} role="group" aria-label={label}>
      {slots.map((slot) => (
        <button
          key={slot.starts_at}
          type="button"
          className={cx(styles.time, 'pressable')}
          aria-pressed={slot.starts_at === selected}
          data-starts-at={slot.starts_at}
          onClick={() => onPick(slot)}
        >
          {shortTime(slot.local_time)}
        </button>
      ))}
    </div>
  )
}
