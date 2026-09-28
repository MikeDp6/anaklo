import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { ButtonLink } from '@/shared/ui/ButtonLink'
import { buildIcs, googleCalendarUrl, type CalendarEvent } from '../../calendar'
import type { BookingFlow } from '../../flow/useBookingFlow'
import { useBookingActions } from './useBookingActions'
import styles from './later.module.css'

/** Identifies our .ics files to calendar apps (not a UI text). */
const ICS_PRODUCT_ID = '-//Anaklo//Booking//EL'

/** A map link: the business's own, else a search for its address. */
function mapUrl(mapsUrl: string | null, address: string | null): string | null {
  if (mapsUrl) return mapsUrl
  return address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : null
}

/** Saves the .ics through a short-lived blob URL (works in iOS Safari and in-app browsers). */
function downloadIcs(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The confirmation's actions: manage link (main), calendars, map, book again, forget device. */
export function ConfirmLinks({ flow, serviceName }: { flow: BookingFlow; serviceName: string }) {
  const { t } = useTranslation('booking')
  const actions = useBookingActions(flow)
  const [forgotten, setForgotten] = useState(false)
  const { catalogue, state, dispatch } = flow
  const result = state.booking
  if (!result) return null
  const { business } = catalogue
  const managePath = `/m/${result.manage_token}`
  const event: CalendarEvent = {
    uid: `${result.appointment.id}@anaklo`,
    title: t('done.calendarTitle', { service: serviceName, business: business.name }),
    description: t('done.calendarDescription', { link: `${window.location.origin}${managePath}` }),
    location: business.address,
    start: new Date(result.appointment.starts_at),
    end: new Date(result.appointment.ends_at),
  }
  const map = mapUrl(business.maps_url, business.address)

  return (
    <div className={styles.links}>
      <ButtonLink href={managePath} variant="primary" block>
        {t('done.manage')}
      </ButtonLink>
      <ButtonLink href={googleCalendarUrl(event)} target="_blank" rel="noopener noreferrer" block>
        {t('done.google')}
      </ButtonLink>
      <Button
        variant="secondary"
        block
        onClick={() =>
          downloadIcs(
            buildIcs(event, new Date(), ICS_PRODUCT_ID),
            `${business.slug}-${result.appointment.starts_at.slice(0, 10)}.ics`,
          )
        }
      >
        {t('done.ics')}
      </Button>
      {map && (
        <ButtonLink href={map} target="_blank" rel="noopener noreferrer" block>
          {t('done.map')}
        </ButtonLink>
      )}
      <Button variant="secondary" block onClick={() => dispatch({ type: 'restart' })}>
        {t('done.again')}
      </Button>
      {forgotten ? (
        <p className={styles.status} role="status">
          {t('done.forgotten')}
        </p>
      ) : (
        <button
          type="button"
          className={styles.textButton}
          onClick={() => void actions.forget().then((ok) => setForgotten(ok))}
        >
          {t('done.forget')}
        </button>
      )}
    </div>
  )
}
