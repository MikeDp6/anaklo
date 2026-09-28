import { useTranslation } from 'react-i18next'
import { Outlet } from 'react-router'
import { SignOutButton } from '@/features/auth/components/SignOutButton'
import styles from './MemberLayout.module.css'

/** Frame of the signed-in area. The real navigation arrives with the pro screens (1.4). */
export function MemberLayout() {
  const { t } = useTranslation()
  return (
    <>
      <header className={styles.bar}>
        <span className={styles.brand}>{t('app.name')}</span>
        <SignOutButton />
      </header>
      <Outlet />
    </>
  )
}
