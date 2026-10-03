import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { formatShortDate, useAppLocale } from '@/features/calendar/format'
import { toLocalDate } from '@/shared/lib/dates'
import { formatPhone } from '@/shared/lib/phone'
import { cx } from '@/shared/ui/cx'
import type { ClientHit } from '../schema'
import styles from './clients.module.css'

/**
 * The results of `search_clients` (contract 1.8 §4.2): name, phone and «Τελευταία επίσκεψη» in
 * the business zone (once it is known), each row a link to the card (E16, ≥ 56px). `back` is
 * where the card's back link returns: this search.
 */
export function ClientHitList({
  hits,
  timeZone,
  back,
}: {
  hits: readonly ClientHit[]
  /** The business zone; null while it loads (the dates wait for it). */
  timeZone: string | null
  back: string
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  return (
    <ul className={styles.hits} aria-label={t('clients.search.results')}>
      {hits.map((hit) => {
        const meta = [
          hit.phoneE164 ? formatPhone(hit.phoneE164) : null,
          hit.lastVisitAt && timeZone
            ? t('clients.search.lastVisit', {
                date: formatShortDate(toLocalDate(new Date(hit.lastVisitAt), timeZone), locale),
              })
            : null,
        ].filter(Boolean)
        return (
          <li key={hit.id}>
            <Link
              to={`/clients/${hit.id}`}
              state={{ back }}
              className={cx(styles.hit, 'pressable')}
            >
              <span className={styles.hitName}>{hit.fullName}</span>
              {meta.length > 0 && <span className={styles.meta}>{meta.join(' · ')}</span>}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
