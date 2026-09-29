import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { formatLongDate, formatTime, useAppLocale } from '@/features/calendar/format'
import type { Workspace } from '@/features/calendar/hooks/useWorkspace'
import { toLocalDate, type LocalDate } from '@/shared/lib/dates'
import { cx } from '@/shared/ui/cx'
import { QUICK_ADD_STEPS, useQuickAddFlow, type QuickAddPreset } from '../hooks/useQuickAddFlow'
import { ClientStep } from './ClientStep'
import styles from './forms.module.css'
import { SaveSuccess } from './SaveSuccess'
import { ServiceStep } from './ServiceStep'
import { Sheet } from './Sheet'
import { TimeStep } from './TimeStep'

/**
 * «Νέο ραντεβού» (SPEC §5 flow 3, contract 1.4): client (search or new inline) → service → staff
 * and time → one round trip. E14 between the steps, E15 only once the server answered.
 */
export function QuickAddSheet({
  workspace,
  today,
  preset = {},
  onClose,
}: {
  workspace: Workspace
  today: LocalDate
  preset?: QuickAddPreset
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const flow = useQuickAddFlow(workspace, today, preset)
  const { business } = workspace
  const index = QUICK_ADD_STEPS.indexOf(flow.step)
  const booked = flow.book.result
  const stepRef = useRef<HTMLDivElement>(null)
  // The tapped control (a client, a service, «Νέος πελάτης») is gone with its step: the focus
  // moves to what replaced it, as the booking page's StepSection does, never to <body>.
  const view = `${flow.step}:${flow.values.clientMode}`
  const shownView = useRef(view)
  useEffect(() => {
    if (shownView.current === view) return
    shownView.current = view
    stepRef.current?.focus({ preventScroll: true })
  }, [view])
  // After any attempt, closing reloads the day: it shows whether an unknown outcome was saved.
  const close = () => {
    flow.book.refreshInvolved()
    onClose()
  }

  if (booked) {
    const staffName =
      workspace.staff.find((member) => member.id === booked.staffId)?.displayName ?? ''
    const summary = t('quickAdd.doneSummary', {
      client: flow.values.clientName,
      date: formatLongDate(toLocalDate(new Date(booked.startsAt), business.timeZone), locale),
      time: formatTime(booked.startsAt, business.timeZone, locale),
      staff: staffName,
    })
    return (
      <Sheet title={t('quickAdd.title')} onClose={close}>
        <SaveSuccess
          title={t('quickAdd.done')}
          summary={summary}
          warnings={booked.warnings}
          smsNotSent={false}
          onDone={close}
        />
      </Sheet>
    )
  }

  return (
    <Sheet title={t('quickAdd.title')} onClose={close}>
      <form className={styles.stack} onSubmit={(event) => void flow.submit(event)} noValidate>
        <p className={styles.muted} aria-live="polite">
          {t('quickAdd.progress', { step: index + 1, total: QUICK_ADD_STEPS.length })}
          {' · '}
          {t(`quickAdd.steps.${flow.step}`)}
        </p>
        <div
          key={flow.step}
          ref={stepRef}
          tabIndex={-1}
          role="group"
          aria-label={t(`quickAdd.steps.${flow.step}`)}
          className={cx(
            styles.stack,
            styles.step,
            flow.direction === 'forward' && 'step-enter',
            flow.direction === 'back' && 'step-enter-back',
          )}
        >
          {flow.step === 'client' && (
            <ClientStep
              businessId={workspace.businessId}
              timeZone={business.timeZone}
              flow={flow}
            />
          )}
          {flow.step === 'service' && (
            <ServiceStep services={workspace.services} currency={business.currency} flow={flow} />
          )}
          {flow.step === 'time' && (
            <TimeStep workspace={workspace} today={today} flow={flow} onClose={close} />
          )}
        </div>
      </form>
    </Sheet>
  )
}
