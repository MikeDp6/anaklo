import { useTranslation } from 'react-i18next'
import { useAppLocale } from '@/features/calendar/format'
import { toLocalDate } from '@/shared/lib/dates'
import { formatPhone } from '@/shared/lib/phone'
import { Button } from '@/shared/ui/Button'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { formatCardDate } from '../format'
import type { LiveClientCard } from '../schema'
import styles from './clients.module.css'

/**
 * Who the client is (contract 1.8 §4.3 item 1): name, mobile, whether an online booking verified
 * it, the language of their messages, since when, and the names merged into this card. «Επεξεργασία
 * στοιχείων» is secondary here; without a mobile it is the card's primary action instead (D20).
 */
export function ClientHeader({ card, onEdit }: { card: LiveClientCard; onEdit: () => void }) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const { details } = card
  const aliases = details.aliases.map((alias) => alias.fullName).filter(Boolean)
  return (
    <section className={styles.stack}>
      <DisplayTitle size="md" className={styles.name}>
        {details.fullName}
      </DisplayTitle>
      <ul className={styles.facts}>
        <li>{details.phoneE164 ? formatPhone(details.phoneE164) : t('clients.details.noPhone')}</li>
        {details.phoneVerifiedAt && (
          <li className={styles.verified}>{t('clients.details.verified')}</li>
        )}
        <li className={styles.meta}>
          {t('clients.details.locale', {
            language: t(`clients.languages.${details.locale}`),
          })}
        </li>
        <li className={styles.meta}>
          {t('clients.details.since', {
            date: formatCardDate(toLocalDate(new Date(details.createdAt), card.timeZone), locale),
          })}
        </li>
        {aliases.length > 0 && (
          <li className={styles.meta}>
            {t('clients.details.aliases', { names: aliases.join(', ') })}
          </li>
        )}
      </ul>
      {details.phoneE164 && (
        <Button variant="secondary" onClick={onEdit}>
          {t('clients.details.edit')}
        </Button>
      )}
    </section>
  )
}
