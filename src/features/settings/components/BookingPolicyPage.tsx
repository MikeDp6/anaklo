import { useTranslation } from 'react-i18next'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { useBookingPolicy } from '../hooks/useBookingPolicy'
import { useBookingPolicyForm } from '../hooks/useBookingPolicyForm'
import type { SettingsFrame } from '../hooks/useSettingsFrame'
import type { BookingPolicy } from '../schema'
import { FormFailure } from './FormFailure'
import { PolicyFields } from './PolicyFields'
import { ListSkeleton, SettingsScreen } from './SettingsScreen'
import styles from './screens.module.css'

/**
 * /settings/booking-policy (owner, manager; contract 1.6 §4.8; built last, C1): online booking,
 * notice, cancellation, auto-complete, correction window, «Οποιοσδήποτε», SMS reminders, when the
 * reminder goes out and the quiet hours. One primary action «Αποθήκευση».
 */
export function BookingPolicyPage() {
  const { t } = useTranslation('pro')
  return (
    <SettingsScreen title={t('policy.title')} loadingLabel={t('policy.loading')}>
      {(frame) => <Policy frame={frame} />}
    </SettingsScreen>
  )
}

function Policy({ frame }: { frame: SettingsFrame }) {
  const { t } = useTranslation('pro')
  const policy = useBookingPolicy(frame.businessId)
  const retry = () => void policy.refetch()
  if (failedWithoutData(policy)) {
    return <LoadError failure={failureOf(policy.error)} onRetry={retry} />
  }
  if (policy.data === undefined) return <ListSkeleton label={t('policy.loading')} rows={4} />
  return (
    <>
      {failedRefresh(policy) && <RefreshError failure={failureOf(policy.error)} onRetry={retry} />}
      <BookingPolicyForm businessId={frame.businessId} policy={policy.data} />
    </>
  )
}

/** The form; it starts from the stored policy and is refilled from each save's answer. */
export function BookingPolicyForm({
  businessId,
  policy,
}: {
  businessId: string
  policy: BookingPolicy
}) {
  const { t } = useTranslation('pro')
  const state = useBookingPolicyForm(businessId, policy)
  const { update, form } = state
  const saved = update.succeeded && !form.formState.isDirty

  return (
    <form className={styles.stack} onSubmit={(event) => void state.submit(event)} noValidate>
      <fieldset className={styles.stack} disabled={state.busy}>
        <PolicyFields state={state} stored={policy} />
      </fieldset>
      <FormFailure
        failure={update.failure}
        locked={update.locked}
        pending={update.pending}
        onRetry={update.retry}
        onClose={update.reset}
      />
      {saved && (
        <p role="status" className={styles.status}>
          {t('form.saved')}
        </p>
      )}
      {!update.locked && (
        <Button type="submit" block disabled={update.pending}>
          {update.pending ? t('form.saving') : t('form.save')}
        </Button>
      )}
    </form>
  )
}
