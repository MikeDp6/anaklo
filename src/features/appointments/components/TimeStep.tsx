import { useTranslation } from 'react-i18next'
import type { Workspace } from '@/features/calendar/hooks/useWorkspace'
import type { LocalDate } from '@/shared/lib/dates'
import { Button } from '@/shared/ui/Button'
import type { QuickAddFlow } from '../hooks/useQuickAddFlow'
import type { QuickAddErrorKey } from '../quickAddSchema'
import { D8Confirm } from './D8Confirm'
import styles from './forms.module.css'
import { SaveFailure } from './SaveFailure'
import { SlotPicker } from './SlotPicker'
import { StaffPicker } from './StaffPicker'

/**
 * Step 3: staff member (preselected) and a free time, then the one booking call. While a save
 * runs or its outcome is unknown the choices are locked (fieldset disabled); the retry/close of
 * the unknown outcome sit outside the fieldset.
 */
export function TimeStep({
  workspace,
  today,
  flow,
  onClose,
}: {
  workspace: Workspace
  today: LocalDate
  flow: QuickAddFlow
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const { values, service, book, busy } = flow
  const offering = workspace.activeStaff.filter(
    (member) => !service || service.offers.some((offer) => offer.staffId === member.id),
  )
  const errors = flow.form.formState.errors
  const fieldError = errors.startsAt?.message ?? errors.staffId?.message

  return (
    <div className={styles.stack}>
      <fieldset className={styles.fieldset} disabled={busy}>
        <legend className="visually-hidden">{t('quickAdd.steps.time')}</legend>
        <div className={styles.stack}>
          <p className={styles.muted}>
            {t('quickAdd.forClient', { client: values.clientName })}
            {service ? ` · ${service.name}` : ''}
          </p>
          <StaffPicker
            staff={offering}
            selected={values.staffId}
            disabled={busy}
            onSelect={flow.pickStaff}
          />
          {values.serviceId && values.staffId && (
            <SlotPicker
              businessId={workspace.businessId}
              serviceIds={[values.serviceId]}
              staffId={values.staffId}
              timeZone={workspace.business.timeZone}
              today={today}
              date={flow.date}
              selected={values.startsAt || null}
              disabled={busy}
              onDateChange={flow.setDate}
              onPick={(slot) => flow.pickTime(slot.startsAt)}
            />
          )}
        </div>
      </fieldset>
      {fieldError && (
        <p role="alert" className={styles.error}>
          {t(fieldError as QuickAddErrorKey)}
        </p>
      )}
      {flow.d8 ? (
        <D8Confirm
          flag={flow.d8}
          pending={book.pending}
          onConfirm={() => flow.d8 && flow.confirmD8(flow.d8)}
        />
      ) : (
        <SaveFailure
          failure={book.failure}
          locked={book.locked}
          pending={book.pending}
          onRetry={book.retry}
          onClose={onClose}
        />
      )}
      {!book.locked && !flow.d8 && (
        <Button type="submit" disabled={book.pending || !values.startsAt} block>
          {book.pending ? t('quickAdd.submitting') : t('quickAdd.submit')}
        </Button>
      )}
      {!book.locked && (
        <Button variant="secondary" onClick={flow.back} disabled={book.pending} block>
          {t('quickAdd.back')}
        </Button>
      )}
    </div>
  )
}
