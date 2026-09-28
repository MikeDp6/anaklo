import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ClientFullName } from '@fn-shared/booking-schemas.ts'
import { formatPhone, isGreekMobile, normalizePhone } from '@/shared/lib/phone'
import { Button } from '@/shared/ui/Button'
import { TextField } from '@/shared/ui/TextField'
import type { BookingFlow } from '../../flow/useBookingFlow'
import { StepSection } from '../StepSection'
import { AppointmentSummary } from './AppointmentSummary'
import { SlotTakenPanel } from './SlotTakenPanel'
import { StepError } from './StepError'
import { useBookingActions } from './useBookingActions'
import styles from './later.module.css'

type FieldErrors = { name?: string; phone?: string }

/**
 * Step 4: name, mobile (E.164 via phone.ts, +3069 only) and the marketing refusal box (checked =
 * refused; left alone = soft opt-in, recorded by the server with the notice version). The OTP is
 * asked only when this device is not trusted yet (the server decides, contract decision 6).
 */
export function DetailsStep({ flow }: { flow: BookingFlow }) {
  const { t } = useTranslation('booking')
  const actions = useBookingActions(flow)
  const { state, catalogue } = flow
  const [name, setName] = useState(state.details?.fullName ?? '')
  const [phone, setPhone] = useState(state.details ? formatPhone(state.details.phone) : '')
  const [refused, setRefused] = useState(state.details?.marketingRefused ?? false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const pending = state.pending !== null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const fullName = ClientFullName.safeParse(name)
    const normalized = normalizePhone(phone)
    const mobile = normalized.ok && isGreekMobile(normalized.e164) ? normalized.e164 : null
    const next: FieldErrors = {
      name: fullName.success ? undefined : t('details.nameRequired'),
      phone: mobile ? undefined : t('details.phoneInvalid'),
    }
    setErrors(next)
    if (!fullName.success || !mobile) return
    void actions.submitDetails({
      fullName: fullName.data,
      phone: mobile,
      marketingRefused: refused,
    })
  }

  return (
    <StepSection
      direction={state.direction}
      eyebrow={t('details.eyebrow')}
      title={t('details.title')}
    >
      <AppointmentSummary flow={flow} />
      <SlotTakenPanel flow={flow} />
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          label={t('details.name')}
          name="name"
          autoComplete="name"
          value={name}
          maxLength={120}
          error={errors.name ?? null}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={t('details.phone')}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          hint={t('details.phoneHint')}
          error={errors.phone ?? null}
          onChange={(event) => setPhone(event.target.value)}
        />
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={refused}
            onChange={(event) => setRefused(event.target.checked)}
          />
          <span>{t('details.marketing')}</span>
        </label>
        <p className={styles.notice}>{t('details.notice')}</p>
        {state.error && state.error !== 'AN001' && (
          <StepError code={state.error} phone={catalogue.business.phone_e164} />
        )}
        <Button type="submit" liquid block disabled={pending} aria-busy={pending}>
          {pending ? t('details.sending') : t('details.submit')}
        </Button>
      </form>
    </StepSection>
  )
}
