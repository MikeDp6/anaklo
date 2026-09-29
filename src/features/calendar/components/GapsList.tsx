import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { formatTime, useAppLocale } from '../format'
import type { Workspace } from '../hooks/useWorkspace'
import type { TodayGap } from '../schema'
import styles from './Today.module.css'

/** «Κενά» of today (computed in SQL), each with «Κλείσε ραντεβού» preset on its start. */
export function GapsList({
  workspace,
  gaps,
  showStaff,
  onBook,
}: {
  workspace: Workspace
  gaps: readonly TodayGap[]
  showStaff: boolean
  onBook: (gap: TodayGap) => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const zone = workspace.business.timeZone
  return (
    <section className={styles.section} aria-labelledby="today-gaps">
      <h2 id="today-gaps" className={styles.sectionTitle}>
        {t('today.gaps')}
      </h2>
      {gaps.length === 0 ? (
        <p className={styles.muted}>{t('today.gapsEmpty')}</p>
      ) : (
        <ul className={styles.list} role="list">
          {gaps.map((gap) => {
            const staff = workspace.staff.find((member) => member.id === gap.staffId)
            return (
              <li key={`${gap.staffId}-${gap.startsAt}`} className={styles.gap}>
                <span className={styles.itemMain}>
                  <span className={styles.itemTitle}>
                    {t('today.gapRange', {
                      from: formatTime(gap.startsAt, zone, locale),
                      to: formatTime(gap.endsAt, zone, locale),
                    })}
                  </span>
                  <span className={styles.muted}>
                    {t('today.gapMinutes', { minutes: gap.minutes })}
                    {showStaff && staff ? ` · ${staff.displayName}` : ''}
                  </span>
                </span>
                <Button variant="secondary" onClick={() => onBook(gap)}>
                  {t('today.gapBook')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
