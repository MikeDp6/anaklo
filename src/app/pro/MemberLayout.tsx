import { useTranslation } from 'react-i18next'
import { NavLink, Outlet } from 'react-router'
import { SignOutButton } from '@/features/auth/components/SignOutButton'
import { cx } from '@/shared/ui/cx'
import styles from './MemberLayout.module.css'

/**
 * Frame of the signed-in area: brand + sign-out on top, a bottom tab bar (one hand, thumb reach)
 * with the two day screens and «Ρυθμίσεις» (every role: notifications are per user; the 1.6
 * screens join that list, not the bar). The settings tab stays active on its sub-screens.
 */
export function MemberLayout() {
  const { t } = useTranslation(['pro', 'common'])
  const tab = ({ isActive }: { isActive: boolean }) =>
    cx(styles.tab, 'pressable', isActive && styles.active)
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <span className={styles.brand}>{t('common:app.name')}</span>
        <SignOutButton />
      </header>
      <Outlet />
      <nav className={styles.nav} aria-label={t('nav.label')}>
        <NavLink to="/" end className={tab}>
          {t('nav.today')}
        </NavLink>
        <NavLink to="/day" className={tab}>
          {t('nav.day')}
        </NavLink>
        <NavLink to="/settings" className={tab}>
          {t('nav.settings')}
        </NavLink>
      </nav>
    </div>
  )
}
