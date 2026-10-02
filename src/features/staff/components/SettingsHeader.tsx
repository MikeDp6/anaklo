import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { cx } from '@/shared/ui/cx'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import styles from './settings.module.css'

/** Top of a settings sub-page (contract 1.6 §4.1): a back link «Ρυθμίσεις» and the G2 title. */
export function SettingsHeader({ title }: { title: string }) {
  const { t } = useTranslation('pro')
  return (
    <header className={styles.header}>
      <Link
        to="/settings"
        className={cx(styles.back, 'pressable')}
        aria-label={t('settings.backLabel')}
      >
        <span className={styles.backChevron} aria-hidden="true" />
        {t('settings.back')}
      </Link>
      <DisplayTitle size="md">{title}</DisplayTitle>
    </header>
  )
}
