import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { cx } from '@/shared/ui/cx'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Page } from '@/shared/ui/Page'
import styles from './SettingsPage.module.css'

/**
 * The settings screens, one row each (contract 1.5 §4.1). 1.5 has «Ειδοποιήσεις», for every role
 * (notifications are per user); 1.6 appends its screens here, gated to owner/manager.
 */
const ENTRIES = [
  {
    to: '/settings/notifications',
    label: 'settings.notifications',
    hint: 'settings.notificationsHint',
  },
] as const

/** /settings: a list of links, minimal motion (E16 press only). */
export function SettingsPage() {
  const { t } = useTranslation('pro')
  return (
    <Page>
      <DisplayTitle size="md">{t('settings.title')}</DisplayTitle>
      <nav aria-label={t('settings.title')}>
        <ul className={styles.list}>
          {ENTRIES.map((entry) => (
            <li key={entry.to}>
              <Link to={entry.to} className={cx(styles.entry, 'pressable')}>
                <span className={styles.text}>
                  <span className={styles.label}>{t(entry.label)}</span>
                  <span className={styles.hint}>{t(entry.hint)}</span>
                </span>
                <span className={styles.chevron} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </Page>
  )
}
