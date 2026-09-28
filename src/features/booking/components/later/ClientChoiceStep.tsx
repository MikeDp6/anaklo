import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import type { BookingFlow } from '../../flow/useBookingFlow'
import { StepSection } from '../StepSection'
import { AppointmentSummary } from './AppointmentSummary'
import { SlotTakenPanel } from './SlotTakenPanel'
import { StepError } from './StepError'
import { useBookingActions } from './useBookingActions'
import styles from './later.module.css'

/**
 * Step 6: «Κλείνεις ως Γιώργος · άλλο άτομο». Only first names leave the server; a family
 * sharing one mobile picks who the appointment is for, or books someone new (never merged by
 * phone). With nobody to choose, the booking starts by itself and this step shows its progress.
 */
export function ClientChoiceStep({ flow }: { flow: BookingFlow }) {
  const { t } = useTranslation('booking')
  const actions = useBookingActions(flow)
  const { state, dispatch, catalogue } = flow
  const clients = state.proof?.clients ?? []
  const booking = state.pending === 'book'
  const name = state.details?.fullName ?? ''
  const selected = state.pick

  return (
    <StepSection
      direction={state.direction}
      eyebrow={t('client.eyebrow')}
      title={t('client.title')}
    >
      {clients.length > 0 ? (
        <fieldset className={styles.choices}>
          <legend className="visually-hidden">{t('client.title')}</legend>
          {clients.map((client) => (
            <label key={client.id} className={styles.choice}>
              <input
                type="radio"
                name="client"
                checked={selected?.kind === 'existing' && selected.clientId === client.id}
                disabled={state.pending !== null}
                onChange={() =>
                  dispatch({ type: 'pick', pick: { kind: 'existing', clientId: client.id } })
                }
              />
              <span>{client.first_name}</span>
            </label>
          ))}
          <label className={styles.choice}>
            <input
              type="radio"
              name="client"
              checked={selected?.kind === 'new'}
              disabled={state.pending !== null}
              onChange={() => dispatch({ type: 'pick', pick: { kind: 'new' } })}
            />
            <span>{t('client.other', { name })}</span>
          </label>
        </fieldset>
      ) : (
        <p className={styles.status}>{name}</p>
      )}
      <AppointmentSummary flow={flow} />
      <SlotTakenPanel flow={flow} />
      {state.error && state.error !== 'AN001' && (
        <StepError code={state.error} phone={catalogue.business.phone_e164} />
      )}
      <p className="visually-hidden" role="status">
        {booking ? t('client.booking') : ''}
      </p>
      <Button
        liquid
        block
        disabled={state.pending !== null || !selected || state.takenSlot !== null}
        aria-busy={booking}
        onClick={() => void actions.book()}
      >
        {booking ? t('client.booking') : t('client.submit')}
      </Button>
    </StepSection>
  )
}
