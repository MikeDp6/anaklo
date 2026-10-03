import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppLocale } from '@/features/calendar/format'
import { formatPhone } from '@/shared/lib/phone'
import { Button } from '@/shared/ui/Button'
import { ButtonLink } from '@/shared/ui/ButtonLink'
import { formatCardDate } from '../format'
import { useRingText } from '../hooks/useRingText'
import type { LiveClientCard } from '../schema'
import styles from './clients.module.css'
import { RhythmRing } from './RhythmRing'

/**
 * The rhythm and the counters (contract 1.8 §4.3 item 2), with the card's one primary action
 * (D20): «Κλήση» to the client's mobile, or «Επεξεργασία στοιχείων» when there is none. Every
 * number is the server's (visits, last visit, no-shows, the ring): the browser computes nothing.
 */
export function ClientRhythm({ card, onEdit }: { card: LiveClientCard; onEdit: () => void }) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const titleId = useId()
  const text = useRingText(card.ring)
  const { counters } = card
  const phone = card.details.phoneE164
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.sectionTitle}>
        {t('clients.ring.label')}
      </h2>
      <div className={styles.rhythm}>
        <RhythmRing ring={card.ring} />
        <div className={styles.rhythmText}>
          <p>{text.sentence}</p>
          {text.basis && <p className={styles.meta}>{text.basis}</p>}
        </div>
      </div>
      <dl className={styles.counters} aria-label={t('clients.counters.title')}>
        <div>
          <dt>{t('clients.counters.visits')}</dt>
          <dd>{counters.visits}</dd>
        </div>
        <div>
          <dt>{t('clients.counters.lastVisit')}</dt>
          <dd>{counters.lastVisitDate ? formatCardDate(counters.lastVisitDate, locale) : '—'}</dd>
        </div>
        <div>
          <dt>{t('clients.counters.noShows')}</dt>
          <dd>{counters.noShows}</dd>
        </div>
      </dl>
      {phone ? (
        <ButtonLink href={`tel:${phone}`} variant="primary" block>
          {t('appointment.call', { phone: formatPhone(phone) })}
        </ButtonLink>
      ) : (
        <Button block onClick={onEdit}>
          {t('clients.details.edit')}
        </Button>
      )}
    </section>
  )
}
