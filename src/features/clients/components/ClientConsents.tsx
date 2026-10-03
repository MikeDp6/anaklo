import type { TFunction } from 'i18next'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { useAppLocale } from '@/features/calendar/format'
import { toLocalDate } from '@/shared/lib/dates'
import { SwitchField } from '@/shared/ui/SwitchField'
import { consentView, type ConsentView } from '../consentView'
import { formatCardDate } from '../format'
import { useSetConsent } from '../hooks/useClientMutations'
import type { LiveClientCard } from '../schema'
import styles from './clients.module.css'
import { ConsentHistory } from './ConsentHistory'
import { ConsentSheet } from './ConsentSheet'

type Answered = 'recorded' | 'withdrawn' | null

/**
 * «Προσφορές με SMS» (contract 1.8 §4.6, plan 1.8): the switch shows the server's state only
 * (`consents.current`, family-wide), never an optimistic one. On → a sheet where the staff member
 * confirms that the client agreed just now (a new `staff_ui` record); off → the withdrawal at
 * once (never harder than giving it). Below, every record of the family.
 */
export function ClientConsents({ businessId, card }: { businessId: string; card: LiveClientCard }) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const titleId = useId()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [answered, setAnswered] = useState<Answered>(null)
  const withdraw = useSetConsent(businessId, card.clientId, () => setAnswered('withdrawn'))
  const { current, records } = card.consents
  const granted = current.marketing_sms.state === 'granted'
  const view = consentView(current, records)
  const date = (instant: string | null) =>
    instant ? formatCardDate(toLocalDate(new Date(instant), card.timeZone), locale) : '—'

  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.sectionTitle}>
        {t('clients.consents.title')}
      </h2>
      <SwitchField
        label={t('clients.consents.marketingSms')}
        hint={viewText(t, view, date)}
        checked={granted}
        disabled={withdraw.pending || withdraw.locked}
        onChange={(checked) => {
          setAnswered(null)
          if (checked) {
            withdraw.reset()
            setSheetOpen(true)
          } else {
            withdraw.submit({
              clientId: card.clientId,
              purpose: 'marketing_sms',
              granted: false,
              givenBy: null,
            })
          }
        }}
      />
      <SaveFailure
        failure={withdraw.failure}
        locked={withdraw.locked}
        pending={withdraw.pending}
        onRetry={withdraw.retry}
        onClose={withdraw.reset}
      />
      {answered && (
        <p role="status" className={styles.status}>
          {t(answered === 'recorded' ? 'clients.consents.recorded' : 'clients.consents.withdrawn')}
        </p>
      )}
      <ConsentHistory records={records} date={date} />
      {sheetOpen && (
        <ConsentSheet
          businessId={businessId}
          clientId={card.clientId}
          onRecorded={() => {
            setSheetOpen(false)
            setAnswered('recorded')
          }}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </section>
  )
}

function viewText(
  t: TFunction<'pro'>,
  view: ConsentView,
  date: (instant: string | null) => string,
) {
  switch (view.kind) {
    case 'none':
      return t('clients.consents.none')
    case 'bookingForm':
      return t('clients.consents.bookingForm', { date: date(view.at) })
    case 'inShop':
      return t(view.guardian ? 'clients.consents.inShopGuardian' : 'clients.consents.inShop', {
        date: date(view.at),
      })
    case 'refused':
      return t('clients.consents.refused', { date: date(view.at) })
  }
}
