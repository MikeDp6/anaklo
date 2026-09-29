import { useTranslation } from 'react-i18next'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { Page } from '@/shared/ui/Page'
import { useLoginFlow } from '../hooks/useLoginFlow'
import { CodeStep } from './CodeStep'
import { EmailStep } from './EmailStep'
import styles from './LoginPage.module.css'

/** /app/login: email → 6-digit code (ADR-0009 §1, §4, §5). */
export function LoginPage() {
  const { t } = useTranslation(['pro', 'common'])
  const login = useLoginFlow()

  return (
    <Page>
      <header className={styles.header}>
        <Eyebrow>{t('common:app.name')}</Eyebrow>
        <DisplayTitle size="lg">{t('login.title')}</DisplayTitle>
      </header>
      {login.step.name === 'email' ? (
        <EmailStep
          message={login.message}
          formError={login.formError}
          sending={login.sending}
          onSubmit={login.submitEmail}
        />
      ) : (
        <CodeStep
          email={login.step.email}
          message={login.message}
          formError={login.formError}
          verifying={login.verifying}
          sending={login.sending}
          onSubmit={login.submitCode}
          onResend={login.resendCode}
          onChangeEmail={login.changeEmail}
        />
      )}
    </Page>
  )
}
