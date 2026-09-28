import { useTranslation } from 'react-i18next'
import { cx } from '@/shared/ui/cx'
import { serviceGroups, staffPlan } from '../catalogue'
import type { BookingFlow } from '../flow/useBookingFlow'
import { formatPrice } from '../format'
import { Reveal } from './Reveal'
import { StepSection } from './StepSection'
import styles from './steps.module.css'

/** Step 1: one service per booking (D9). Tapping a row is the step's only action. */
export function ServiceStep({ flow }: { flow: BookingFlow }) {
  const { t } = useTranslation('booking')
  const { catalogue, state, dispatch, locale } = flow
  const currency = catalogue.business.currency
  const groups = serviceGroups(catalogue)

  const choose = (serviceId: string) =>
    dispatch({ type: 'service', serviceId, ...staffPlan(catalogue, serviceId) })

  return (
    <StepSection
      direction={state.direction}
      eyebrow={t('service.eyebrow')}
      title={t('service.title')}
    >
      {groups.length === 0 && <p className={styles.empty}>{t('service.empty')}</p>}
      {groups.map((group) => (
        <Reveal key={group.category?.id ?? 'none'} className={styles.group}>
          {group.category && <h3 className={styles.groupTitle}>{group.category.name}</h3>}
          <ul className={styles.options}>
            {group.services.map((service) => (
              <li key={service.id}>
                <button
                  type="button"
                  className={cx(styles.option, 'pressable')}
                  data-selected={service.id === state.serviceId}
                  onClick={() => choose(service.id)}
                >
                  <span className={styles.optionBody}>
                    <span className={styles.optionName}>{service.name}</span>
                    <span className={styles.optionMeta}>
                      {t('units.minutes', { count: service.duration_min })} ·{' '}
                      {formatPrice(service.price_cents, currency, locale)}
                    </span>
                  </span>
                  <span className={styles.chevron} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </Reveal>
      ))}
    </StepSection>
  )
}
