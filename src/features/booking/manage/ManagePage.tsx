import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatPhone } from '@/shared/lib/phone'
import { Button } from '@/shared/ui/Button'
import { ButtonLink } from '@/shared/ui/ButtonLink'
import { ConfirmMark } from '@/shared/ui/ConfirmMark'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'
import { Skeleton } from '@/shared/ui/Skeleton'
import { formatInstantDate, formatInstantTime } from '../format'
import { useBusinessPresentation } from '../hooks/useBusinessPresentation'
import { useErrorText } from '../hooks/useErrorText'
import { ManageDetails } from './ManageDetails'
import { manageState } from './manageState'
import { RescheduleView } from './RescheduleView'
import { useManage } from './useManage'
import styles from './ManagePage.module.css'

/**
 * `/m/<token>` (its own lazy chunk): see, cancel or move one appointment. Works while online
 * booking is off (cancel only). After a cancel every link of the appointment stops working.
 */
export default function ManagePage({ token }: { token: string }) {
  const { t } = useTranslation(['booking', 'common'])
  const errorText = useErrorText()
  const manage = useManage(token)
  const [openedAt] = useState(() => Date.now())
  const view = manage.load.status === 'ready' ? manage.load.view : null
  useBusinessPresentation({
    theme: view?.business.theme,
    locale: view?.business.locale,
    title: view?.business.name ?? t('common:app.name'),
  })

  if (manage.load.status === 'loading') {
    return (
      <Page busy>
        <p role="status" className="visually-hidden">
          {t('common:loading')}
        </p>
        <Skeleton height={40} width="70%" />
        <Skeleton height={180} shape="card" />
      </Page>
    )
  }
  if (!view) {
    const code = manage.load.status === 'error' ? manage.load.code : 'unknown'
    const invalid = code === 'AN015'
    return (
      <Page>
        <Notice
          tone={invalid ? 'info' : 'error'}
          headingLevel={1}
          title={invalid ? errorText(code) : t('errorTitle')}
          body={invalid ? t('notFoundBody') : errorText(code)}
          action={invalid ? undefined : <Button onClick={manage.retry}>{t('common:retry')}</Button>}
        />
      </Page>
    )
  }

  const { business, appointment } = view
  const phone = business.phone_e164
  const state = manageState(view, openedAt)
  const newBooking = (
    <ButtonLink href={`/${business.slug}`} block>
      {t('manage.newBooking')}
    </ButtonLink>
  )
  const when = `${formatInstantDate(appointment.starts_at, business.timezone, business.locale)}, ${formatInstantTime(appointment.starts_at, business.timezone, business.locale)}`

  if (manage.mode === 'cancelled') {
    return (
      <Page>
        <Notice headingLevel={1} title={t('manage.cancelled')} body={when} action={newBooking} />
      </Page>
    )
  }

  return (
    <Page>
      <div className={styles.head}>
        <Eyebrow reveal>{t('manage.eyebrow')}</Eyebrow>
        <DisplayTitle as="h1" size="lg" animate>
          {business.name}
        </DisplayTitle>
      </div>
      {manage.mode === 'moved' && (
        <div className={styles.moved} role="status">
          <ConfirmMark label={t('manage.moved')} size={56} />
          <p className={styles.movedText}>{t('manage.moved')}</p>
        </div>
      )}
      <ManageDetails view={view} />
      {manage.error && (
        <p className={styles.alert} role="alert">
          {errorText(manage.error)}
        </p>
      )}
      {manage.mode === 'reschedule' ? (
        <RescheduleView
          token={token}
          view={view}
          pending={manage.pending === 'reschedule'}
          onMove={manage.reschedule}
          onKeep={() => manage.show('view')}
        />
      ) : (
        <div className={styles.block}>
          {state === 'changeable' && (
            <p className={styles.muted}>
              {t('manage.changeUntil', {
                date: formatInstantDate(view.change_until, business.timezone, business.locale),
                time: formatInstantTime(view.change_until, business.timezone, business.locale),
              })}
            </p>
          )}
          {state === 'call' && <p className={styles.muted}>{t('manage.tooLate')}</p>}
          {state === 'call' && phone && (
            <ButtonLink href={`tel:${phone}`} variant="primary" block>
              {t('call.action', { phone: formatPhone(phone) })}
            </ButtonLink>
          )}
          {state === 'closed' && <p className={styles.muted}>{t('manage.closedStatus')}</p>}
          {view.can_reschedule && manage.mode !== 'confirm-cancel' && (
            <Button liquid block onClick={() => manage.show('reschedule')}>
              {t('manage.reschedule')}
            </Button>
          )}
          {view.can_cancel && manage.mode !== 'confirm-cancel' && (
            <Button variant="secondary" block onClick={() => manage.show('confirm-cancel')}>
              {t('manage.cancel')}
            </Button>
          )}
          {view.can_cancel && manage.mode === 'confirm-cancel' && (
            <div className={styles.confirm} role="group" aria-label={t('manage.cancelConfirm')}>
              <p>{t('manage.cancelConfirm')}</p>
              <Button
                block
                disabled={manage.pending !== null}
                aria-busy={manage.pending === 'cancel'}
                onClick={() => void manage.cancel()}
              >
                {manage.pending === 'cancel' ? t('manage.cancelling') : t('manage.cancelYes')}
              </Button>
              <Button variant="secondary" block onClick={() => manage.show('view')}>
                {t('manage.cancelNo')}
              </Button>
            </div>
          )}
          {newBooking}
        </div>
      )}
    </Page>
  )
}
