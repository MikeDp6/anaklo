import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { formatPrice, formatTime, useAppLocale } from '@/features/calendar/format'
import { toLocalDate } from '@/shared/lib/dates'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { formatCardDate } from '../format'
import type { ClientCardItem, LiveClientCard } from '../schema'
import styles from './clients.module.css'

/** History rows shown before «Δες περισσότερα». */
export const HISTORY_PREVIEW = 10
/** The server sends at most this many past appointments (contract 1.8 D13). */
export const HISTORY_LIMIT = 50

/**
 * «Επόμενα ραντεβού» (each opens its day) and «Ιστορικό» (contract 1.8 §4.3 item 3): local date
 * and time, status, services, staff member and amount. The amount is the server's: null where
 * there is none or the member may not see it (a colleague's appointment for staff) → «—».
 */
export function ClientAppointments({ card }: { card: LiveClientCard }) {
  const { t } = useTranslation('pro')
  const [all, setAll] = useState(false)
  const upcomingId = useId()
  const historyId = useId()
  const shown = all ? card.history : card.history.slice(0, HISTORY_PREVIEW)
  return (
    <>
      <section className={styles.section} aria-labelledby={upcomingId}>
        <h2 id={upcomingId} className={styles.sectionTitle}>
          {t('clients.history.upcoming')}
        </h2>
        {card.upcoming.length === 0 ? (
          <p className={styles.muted}>{t('clients.history.upcomingEmpty')}</p>
        ) : (
          <ul className={styles.items}>
            {card.upcoming.map((item) => (
              <li key={item.appointmentId}>
                <Link
                  to={`/day?date=${toLocalDate(new Date(item.startsAt), card.timeZone)}`}
                  className={cx(styles.item, 'pressable')}
                >
                  <ItemLines item={item} card={card} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.section} aria-labelledby={historyId}>
        <h2 id={historyId} className={styles.sectionTitle}>
          {t('clients.history.title')}
        </h2>
        {card.history.length === 0 ? (
          <p className={styles.muted}>{t('clients.history.empty')}</p>
        ) : (
          <ul className={styles.items}>
            {shown.map((item) => (
              <li key={item.appointmentId}>
                <div className={styles.item}>
                  <ItemLines item={item} card={card} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {!all && card.history.length > HISTORY_PREVIEW && (
          <Button variant="secondary" onClick={() => setAll(true)}>
            {t('clients.history.more')}
          </Button>
        )}
        {(all || card.history.length <= HISTORY_PREVIEW) && card.historyTotal > HISTORY_LIMIT && (
          <p className={styles.meta}>{t('clients.history.capped')}</p>
        )}
      </section>
    </>
  )
}

function ItemLines({ item, card }: { item: ClientCardItem; card: LiveClientCard }) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const zone = card.timeZone
  const amount =
    item.amountCents === null ? '—' : formatPrice(item.amountCents, card.currency, locale)
  return (
    <>
      <span className={styles.itemTop}>
        <span>
          {formatCardDate(toLocalDate(new Date(item.startsAt), zone), locale)}
          {' · '}
          {formatTime(item.startsAt, zone, locale)}
        </span>
        <span className={styles.badge} data-status={item.status}>
          {t(`appointment.status.${item.status}`)}
        </span>
      </span>
      <span className={styles.meta}>
        {[item.serviceNames.join(', '), item.staffName].filter(Boolean).join(' · ')}
      </span>
      <span className={styles.meta}>{t('clients.history.amount', { amount })}</span>
    </>
  )
}
