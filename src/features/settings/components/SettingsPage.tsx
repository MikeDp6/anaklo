import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useMember } from '@/features/auth/hooks/useMember'
import { cx } from '@/shared/ui/cx'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Page } from '@/shared/ui/Page'
import { canManageSettings } from '../access'
import styles from './SettingsPage.module.css'

/**
 * The settings screens, one row each, in this order (contract 1.6 §4.1). Owner and manager see
 * every entry; staff only «Ειδοποιήσεις» (notifications are per user, contract 1.5 §4.1).
 */
const SETTINGS_ENTRIES = [
  {
    to: '/settings/absence',
    label: 'settings.absence',
    hint: 'settings.absenceHint',
    managers: true,
  },
  {
    to: '/settings/services',
    label: 'settings.services',
    hint: 'settings.servicesHint',
    managers: true,
  },
  { to: '/settings/staff', label: 'settings.staff', hint: 'settings.staffHint', managers: true },
  { to: '/settings/hours', label: 'settings.hours', hint: 'settings.hoursHint', managers: true },
  {
    to: '/settings/closures',
    label: 'settings.closures',
    hint: 'settings.closuresHint',
    managers: true,
  },
  {
    to: '/settings/time-off',
    label: 'settings.timeOff',
    hint: 'settings.timeOffHint',
    managers: true,
  },
  {
    to: '/settings/booking-policy',
    label: 'settings.policy',
    hint: 'settings.policyHint',
    managers: true,
  },
  {
    to: '/settings/notifications',
    label: 'settings.notifications',
    hint: 'settings.notificationsHint',
    managers: false,
  },
] as const

/** /settings: a list of links, minimal motion (E16 press only). */
export function SettingsPage() {
  const { t } = useTranslation('pro')
  const { membership } = useMember()
  const manager = canManageSettings(membership.role)
  const entries = SETTINGS_ENTRIES.filter((entry) => manager || !entry.managers)
  return (
    <Page>
      <DisplayTitle size="md">{t('settings.title')}</DisplayTitle>
      <nav aria-label={t('settings.title')}>
        <ul className={styles.list}>
          {entries.map((entry) => (
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
