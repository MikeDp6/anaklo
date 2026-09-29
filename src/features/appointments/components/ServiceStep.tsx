import { useTranslation } from 'react-i18next'
import { formatPrice, useAppLocale } from '@/features/calendar/format'
import type { Service } from '@/features/services/schema'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import type { QuickAddFlow } from '../hooks/useQuickAddFlow'
import type { QuickAddErrorKey } from '../quickAddSchema'
import styles from './forms.module.css'

/** Step 2: one tap on a service moves on (one service per booking in Phase 1, D9). */
export function ServiceStep({
  services,
  currency,
  flow,
}: {
  services: readonly Service[]
  currency: string
  flow: QuickAddFlow
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const error = flow.form.formState.errors.serviceId?.message
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>{t('quickAdd.forClient', { client: flow.values.clientName })}</p>
      <ul className={styles.actions} role="list" aria-label={t('quickAdd.steps.service')}>
        {services.map((service) => (
          <li key={service.id}>
            <button
              type="button"
              className={cx(styles.option, 'pressable')}
              aria-pressed={service.id === flow.values.serviceId}
              onClick={() => flow.pickService(service.id)}
            >
              <span className={styles.optionMain}>
                <span className={styles.optionTitle}>{service.name}</span>
                <span className={styles.optionMeta}>
                  {t('quickAdd.duration', { minutes: service.durationMin })}
                </span>
              </span>
              <span className={styles.optionMeta}>
                {formatPrice(service.priceCents, currency, locale)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className={styles.error}>
          {t(error as QuickAddErrorKey)}
        </p>
      )}
      <Button variant="secondary" onClick={flow.back} block>
        {t('quickAdd.back')}
      </Button>
    </div>
  )
}
