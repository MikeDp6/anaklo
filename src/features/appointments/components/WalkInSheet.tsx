import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime, useAppLocale } from '@/features/calendar/format'
import type { Workspace } from '@/features/calendar/hooks/useWorkspace'
import type { BookInput } from '@/features/calendar/schema'
import { Button } from '@/shared/ui/Button'
import { TextField } from '@/shared/ui/TextField'
import { cx } from '@/shared/ui/cx'
import { useAttemptKey } from '../attemptKey'
import { useBookAction } from '../hooks/useAppointmentActions'
import { d8FlagOf, NO_D8_FLAGS, withD8Flag, type D8Flag, type D8Flags } from '../rules'
import { D8Confirm } from './D8Confirm'
import styles from './forms.module.css'
import { SaveFailure } from './SaveFailure'
import { SaveSuccess } from './SaveSuccess'
import { Sheet } from './Sheet'

/** Now, to the minute: a walk-in starts when it is entered. */
function startOfCurrentMinute(): string {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString()
}

/**
 * Walk-in for the staff member that was tapped (SPEC §5 flow 3): a service, optionally a name,
 * no phone. Starts now; outside the hours or inside a buffer the server asks (AN005/AN006) and a
 * confirmed retry is a new attempt with the flag.
 */
export function WalkInSheet({
  workspace,
  staffId,
  onClose,
}: {
  workspace: Workspace
  staffId: string
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const { business } = workspace
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [flags, setFlags] = useState<D8Flags>(NO_D8_FLAGS)
  const keyFor = useAttemptKey()
  const book = useBookAction({ businessId: workspace.businessId, timeZone: business.timeZone })
  const staffName = workspace.staff.find((member) => member.id === staffId)?.displayName ?? ''
  const services = workspace.services.filter((service) =>
    service.offers.some((offer) => offer.staffId === staffId),
  )
  const busy = book.pending || book.locked
  const d8 = book.failure?.kind === 'domain' ? d8FlagOf(book.failure.code) : null
  const close = () => {
    book.refreshInvolved()
    onClose()
  }

  const send = (withFlags: D8Flags) => {
    if (!serviceId) return
    const fullName = name.trim()
    const payload: Omit<BookInput, 'idempotencyKey' | 'startsAt'> = {
      serviceIds: [serviceId],
      staffId,
      source: 'walkin',
      ...withFlags,
      client:
        fullName === ''
          ? { kind: 'none' }
          : { kind: 'new', fullName, phoneE164: null, locale: business.locale },
    }
    book.submit({ ...payload, startsAt: startOfCurrentMinute(), idempotencyKey: keyFor(payload) })
  }

  const confirmD8 = (flag: D8Flag) => {
    const next = withD8Flag(flags, flag)
    setFlags(next)
    send(next)
  }

  const title = t('walkIn.title', { name: staffName })
  if (book.result) {
    return (
      <Sheet title={title} onClose={close}>
        <SaveSuccess
          title={t('walkIn.done')}
          summary={t('walkIn.doneSummary', {
            time: formatTime(book.result.startsAt, business.timeZone, locale),
            staff: staffName,
          })}
          warnings={book.result.warnings}
          onDone={close}
        />
      </Sheet>
    )
  }

  return (
    <Sheet title={title} onClose={close}>
      <fieldset className={styles.fieldset} disabled={busy}>
        <legend className={styles.legend}>{t('walkIn.service')}</legend>
        <ul className={styles.actions} role="list">
          {services.map((service) => (
            <li key={service.id}>
              <button
                type="button"
                className={cx(styles.option, 'pressable')}
                aria-pressed={service.id === serviceId}
                onClick={() => {
                  setServiceId(service.id)
                  setFlags(NO_D8_FLAGS)
                  book.reset()
                }}
              >
                <span className={styles.optionTitle}>{service.name}</span>
                <span className={styles.optionMeta}>
                  {t('quickAdd.duration', { minutes: service.durationMin })}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <TextField
          label={t('walkIn.name')}
          hint={t('walkIn.nameHint')}
          autoComplete="off"
          autoCapitalize="words"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </fieldset>
      {d8 ? (
        <D8Confirm flag={d8} pending={book.pending} onConfirm={() => confirmD8(d8)} />
      ) : (
        <SaveFailure
          failure={book.failure}
          locked={book.locked}
          pending={book.pending}
          onRetry={book.retry}
          onClose={close}
        />
      )}
      {!book.locked && !d8 && (
        <Button onClick={() => send(flags)} disabled={book.pending || !serviceId} block>
          {book.pending ? t('walkIn.submitting') : t('walkIn.submit')}
        </Button>
      )}
    </Sheet>
  )
}
