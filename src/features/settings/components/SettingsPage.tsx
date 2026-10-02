import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useMember } from '@/features/auth/hooks/useMember'
import type { MemberRole } from '@/shared/lib/domain'
import { cx } from '@/shared/ui/cx'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Page } from '@/shared/ui/Page'
import { canManageSettings, isOwner } from '../access'
import styles from './SettingsPage.module.css'

/** Who sees an entry: owner and manager, the owner only (contract 1.7 D6), or everyone. */
type Audience = 'managers' | 'owner' | 'all'

interface SettingsEntry {
  readonly to: string
  readonly label: string
  readonly hint: string
  readonly audience: Audience
}

/**
 * The settings screens, one row each, in this order (contract 1.6 §4.1, 1.7 §6.1): the seven
 * schedule screens (owner, manager), then «Μέλη» and «Ταυτότητα επιχείρησης» (owner), «Ασφάλεια»
 * and «Ειδοποιήσεις» (everyone; notifications are per user, contract 1.5 §4.1).
 */
const SETTINGS_ENTRIES = [
  {
    to: '/settings/absence',
    label: 'settings.absence',
    hint: 'settings.absenceHint',
    audience: 'managers',
  },
  {
    to: '/settings/services',
    label: 'settings.services',
    hint: 'settings.servicesHint',
    audience: 'managers',
  },
  {
    to: '/settings/staff',
    label: 'settings.staff',
    hint: 'settings.staffHint',
    audience: 'managers',
  },
  {
    to: '/settings/hours',
    label: 'settings.hours',
    hint: 'settings.hoursHint',
    audience: 'managers',
  },
  {
    to: '/settings/closures',
    label: 'settings.closures',
    hint: 'settings.closuresHint',
    audience: 'managers',
  },
  {
    to: '/settings/time-off',
    label: 'settings.timeOff',
    hint: 'settings.timeOffHint',
    audience: 'managers',
  },
  {
    to: '/settings/booking-policy',
    label: 'settings.policy',
    hint: 'settings.policyHint',
    audience: 'managers',
  },
  {
    to: '/settings/members',
    label: 'settings.members',
    hint: 'settings.membersHint',
    audience: 'owner',
  },
  {
    to: '/settings/identity',
    label: 'settings.identity',
    hint: 'settings.identityHint',
    audience: 'owner',
  },
  {
    to: '/settings/security',
    label: 'settings.security',
    hint: 'settings.securityHint',
    audience: 'all',
  },
  {
    to: '/settings/notifications',
    label: 'settings.notifications',
    hint: 'settings.notificationsHint',
    audience: 'all',
  },
] as const satisfies readonly SettingsEntry[]

function sees(role: MemberRole, audience: Audience): boolean {
  if (audience === 'owner') return isOwner(role)
  if (audience === 'managers') return canManageSettings(role)
  return true
}

/** /settings: a list of links, minimal motion (E16 press only). */
export function SettingsPage() {
  const { t } = useTranslation('pro')
  const { membership } = useMember()
  const entries = SETTINGS_ENTRIES.filter((entry) => sees(membership.role, entry.audience))
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
