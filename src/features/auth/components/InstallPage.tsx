import { useTranslation } from 'react-i18next'
import { Page } from '@/shared/ui/Page'
import styles from './InstallPage.module.css'

/**
 * iOS outside the installed app (ADR-0009 §5): a sign-in here would stay in Safari, and push
 * works only from the Home Screen. So the app asks to be installed first.
 */
export function InstallPage() {
  const { t } = useTranslation(['pro', 'common'])
  return (
    <Page>
      <header className={styles.header}>
        <p className={styles.brand}>{t('common:app.name')}</p>
        <h1>{t('install.title')}</h1>
      </header>
      <p>{t('install.intro')}</p>
      <ol className={styles.steps}>
        <li>{t('install.stepShare')}</li>
        <li>{t('install.stepAdd')}</li>
        <li>{t('install.stepOpen')}</li>
      </ol>
      <p className={styles.note}>{t('install.note')}</p>
    </Page>
  )
}
