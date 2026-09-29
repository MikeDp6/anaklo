import { useTranslation } from 'react-i18next'
import { NavLink, Outlet } from 'react-router'
import { SignOutButton } from '@/features/auth/components/SignOutButton'
import { cx } from '@/shared/ui/cx'
import styles from './MemberLayout.module.css'

/**
 * Frame of the signed-in area: brand + sign-out on top, the two day screens in a bottom tab bar
 * (one hand, thumb reach). The settings screens of 1.6 join the bar later.
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
      </nav>
    </div>
  )
}
