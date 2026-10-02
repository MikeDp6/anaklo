import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { TextField } from '@/shared/ui/TextField'
import type { EnrollWizardState } from '../hooks/useEnrollWizard'
import { MAX_DEVICE_NAME_LENGTH, mfaFormErrorKey } from '../mfaSchema'
import styles from './mfa.module.css'

/**
 * Step 1: «Κατέβασε μια εφαρμογή κωδικών» and the device's name (default «Συσκευή N», contract
 * 1.7 D20). «Την έχω» starts the generation; a name the user already has brings them back here
 * with the reason.
 */
export function EnrollDownloadStep({ wizard }: { wizard: EnrollWizardState }) {
  const { t } = useTranslation(['pro', 'common'])
  const { register, formState } = wizard.nameForm
  const formError = mfaFormErrorKey(formState.errors.name?.message)
  const nameError = formError
    ? t(formError, { max: MAX_DEVICE_NAME_LENGTH })
    : wizard.message === 'mfa.errors.nameTaken'
      ? t(wizard.message)
      : null
  const otherMessage =
    wizard.message && wizard.message !== 'mfa.errors.nameTaken' ? wizard.message : null

  return (
    <form className={styles.form} onSubmit={(event) => void wizard.submitName(event)} noValidate>
      <h2 className={styles.stepTitle}>{t('mfa.enroll.download.title')}</h2>
      <p className={styles.lead}>{t('mfa.enroll.download.body')}</p>
      <TextField
        label={t('mfa.deviceName')}
        hint={t('mfa.deviceNameHint')}
        error={nameError}
        autoComplete="off"
        maxLength={MAX_DEVICE_NAME_LENGTH + 20}
        {...register('name')}
      />
      {otherMessage && (
        <p role="alert" className={styles.error}>
          {t(otherMessage)}
        </p>
      )}
      {wizard.generating && (
        <p role="status" className={styles.muted}>
          {t('mfa.enroll.download.preparing')}
        </p>
      )}
      <Button type="submit" block disabled={wizard.generating}>
        {t('mfa.enroll.download.done')}
      </Button>
    </form>
  )
}
