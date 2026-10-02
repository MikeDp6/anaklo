import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import type { SecurityPageState } from '../hooks/useSecurityPage'
import styles from './mfa.module.css'

/**
 * «Αποσύνδεση από όλες τις συσκευές» (contract 1.7 §6.7), for every role, after one confirmation
 * («Θα χρειαστεί νέα σύνδεση σε κάθε συσκευή, και σε αυτή.»). The plain «Αποσύνδεση» on top of
 * every screen keeps ending this device only. When Auth does not confirm, the confirmation stays
 * open with the reason, so the user can try again while still signed in here.
 */
export function SignOutAllSection({ page }: { page: SecurityPageState }) {
  const { t } = useTranslation('pro')
  const { signOutAll } = page
  return (
    <section className={styles.section} aria-labelledby="security-sessions">
      <h2 id="security-sessions" className={styles.sectionTitle}>
        {t('security.sessions')}
      </h2>
      <p className={styles.muted}>{t('security.signOutAllHint')}</p>
      {page.confirmingSignOut ? (
        <div className={styles.stack}>
          <p className={styles.status}>{t('security.signOutAllConfirm')}</p>
          {signOutAll.failed && !signOutAll.pending && (
            <p role="alert" className={styles.status}>
              {t('security.signOutAllFailed')}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={signOutAll.pending}
              onClick={signOutAll.signOutAll}
            >
              {signOutAll.pending ? t('security.signingOutAll') : t('security.signOutAllSubmit')}
            </Button>
            <Button
              variant="secondary"
              disabled={signOutAll.pending}
              onClick={page.cancelSignOutAll}
            >
              {t('security.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" block onClick={page.askSignOutAll}>
          {t('security.signOutAll')}
        </Button>
      )}
    </section>
  )
}
