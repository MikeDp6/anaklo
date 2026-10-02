import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { Page } from '@/shared/ui/Page'
import styles from './mfa.module.css'
import { SignOutButton } from './SignOutButton'

/**
 * Frame of the `mfa/*` screens (contract 1.7 §6.1): no tab bar, the brand, a G2 title, the
 * content, and «Αποσύνδεση» (this device only) as the one way out besides finishing the step.
 */
export function MfaFrame({
  title,
  intro,
  children,
  className,
}: {
  title: string
  intro?: string
  children: ReactNode
  /** E.g. E14 on entering the screen. */
  className?: string
}) {
  const { t } = useTranslation('common')
  return (
    <Page>
      <div className={className ? `${styles.stack} ${className}` : styles.stack}>
        <header className={styles.header}>
          <Eyebrow>{t('app.name')}</Eyebrow>
          <DisplayTitle size="md">{title}</DisplayTitle>
        </header>
        {intro && <p className={styles.lead}>{intro}</p>}
        {children}
      </div>
      <SignOutButton />
    </Page>
  )
}
