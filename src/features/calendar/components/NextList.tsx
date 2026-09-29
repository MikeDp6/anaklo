import { useTranslation } from 'react-i18next'
import { cx } from '@/shared/ui/cx'
import { formatTime, useAppLocale } from '../format'
import type { Workspace } from '../hooks/useWorkspace'
import { serviceNamesOf } from '../labels'
import type { TodayItem } from '../schema'
import styles from './Today.module.css'

/** «Επόμενα»: the next appointments of today (in progress first), tap → the appointment. */
export function NextList({
  workspace,
  items,
  showStaff,
  now,
  onOpen,
}: {
  workspace: Workspace
  items: readonly TodayItem[]
  showStaff: boolean
  now: Date
  onOpen: (item: TodayItem) => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const zone = workspace.business.timeZone
  return (
    <section className={styles.section} aria-labelledby="today-next">
      <h2 id="today-next" className={styles.sectionTitle}>
        {t('today.next')}
      </h2>
      {items.length === 0 ? (
        <p className={styles.muted}>{t('today.nextEmpty')}</p>
      ) : (
        <ul className={styles.list} role="list">
          {items.map((item) => {
            const inProgress = Date.parse(item.startsAt) <= now.getTime()
            const staff = workspace.staff.find((member) => member.id === item.staffId)
            return (
              <li key={item.appointmentId}>
                <button
                  type="button"
                  className={cx(styles.item, 'pressable')}
                  onClick={() => onOpen(item)}
                >
                  <span className={styles.time}>
                    {inProgress ? t('today.inProgress') : formatTime(item.startsAt, zone, locale)}
                  </span>
                  <span className={styles.itemMain}>
                    <span className={styles.itemTitle}>
                      {item.clientName ?? t('appointment.noClient')}
                    </span>
                    <span className={styles.muted}>
                      {serviceNamesOf(workspace, item.serviceIds)}
                      {showStaff && staff ? ` · ${staff.displayName}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
