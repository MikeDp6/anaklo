import { useTranslation } from 'react-i18next'
import { Page } from '@/shared/ui/Page'
import styles from './InstallPage.module.css'

/**
 * iOS outside the installed app (ADR-0009 §5): a sign-in here would stay in Safari, and push
 * works only from the Home Screen. So the app asks to be installed first.
 */
export function InstallPage() {
  const { t } = useTranslation()
  return (
    <Page>
      <header className={styles.header}>
        <p className={styles.brand}>{t('app.name')}</p>
        <h1>{t('pro.install.title')}</h1>
      </header>
      <p>{t('pro.install.intro')}</p>
      <ol className={styles.steps}>
        <li>{t('pro.install.stepShare')}</li>
        <li>{t('pro.install.stepAdd')}</li>
        <li>{t('pro.install.stepOpen')}</li>
      </ol>
      <p className={styles.note}>{t('pro.install.note')}</p>
    </Page>
  )
}
