import { useTranslation } from 'react-i18next'
import type { ConsentRecord } from '../schema'
import styles from './clients.module.css'

/**
 * «Ιστορικό συναινέσεων» (contract 1.8 §4.6): every record of the client's family, newest first
 * (the server's order): what for, yes or no, where it was given, when, and its withdrawal. The
 * records are never rewritten, so this is the whole story.
 */
export function ConsentHistory({
  records,
  date,
}: {
  records: readonly ConsentRecord[]
  /** An instant as the business-local date. */
  date: (instant: string | null) => string
}) {
  const { t } = useTranslation('pro')
  return (
    <details className={styles.history}>
      <summary className="pressable">{t('clients.consents.history')}</summary>
      {records.length === 0 ? (
        <p className={styles.muted}>{t('clients.consents.historyEmpty')}</p>
      ) : (
        <ul className={styles.items}>
          {records.map((record) => (
            <li key={record.id} className={styles.note}>
              <span className={styles.status}>
                {t(`clients.consents.purposes.${record.purpose}`)}
                {' · '}
                {t(record.granted ? 'clients.consents.yes' : 'clients.consents.no')}
              </span>
              <span className={styles.meta}>
                {[
                  t(`clients.consents.sources.${record.source}`),
                  record.givenBy === 'guardian' ? t('clients.consents.guardianShort') : null,
                  date(record.createdAt),
                  record.withdrawnAt
                    ? t('clients.consents.withdrawnAt', { date: date(record.withdrawnAt) })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
