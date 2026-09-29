import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useCountUp } from '@/shared/motion/useCountUp'
import { Button } from '@/shared/ui/Button'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { formatPrice, useAppLocale } from '../format'
import { useTodayCountUp } from '../hooks/useTodayCountUp'
import type { TodaySummary } from '../schema'
import styles from './Today.module.css'

/**
 * The numbers of «Σήμερα», each with its action (CLAUDE.md > UI). E6 counts them up only on the
 * first load of the business-local day on this device; reduced motion shows them at once
 * (inside useCountUp). Mounted with `key={localDate}`, only once the summary has arrived.
 */
export function TodayStats({ businessId, summary }: { businessId: string; summary: TodaySummary }) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const navigate = useNavigate()
  const countUp = useTodayCountUp(businessId, summary.timeZone)
  const total = useCountUp(summary.counts.total, { enabled: countUp })
  const revenueCents = summary.expectedRevenueCents
  const revenue = useCountUp(revenueCents ?? 0, { enabled: countUp })
  const openDay = () => void navigate('/day')

  return (
    <div className={styles.stats}>
      <section className={styles.stat} aria-labelledby="today-total">
        <Eyebrow>
          <span id="today-total">
            {summary.scope === 'own' ? t('today.appointmentsOwn') : t('today.appointments')}
          </span>
        </Eyebrow>
        <p className={styles.number} data-testid="today-total">
          <span aria-hidden="true">{total}</span>
          <span className="visually-hidden">{summary.counts.total}</span>
        </p>
        <p className={styles.muted}>{t('today.remaining', { count: summary.counts.remaining })}</p>
        <Button variant="secondary" onClick={openDay}>
          {t('today.openDay')}
        </Button>
      </section>
      {revenueCents !== null && (
        <section className={styles.stat} aria-labelledby="today-revenue">
          <Eyebrow>
            <span id="today-revenue">{t('today.revenue')}</span>
          </Eyebrow>
          <p className={styles.number} data-testid="today-revenue">
            <span aria-hidden="true">{formatPrice(revenue, summary.currency, locale)}</span>
            <span className="visually-hidden">
              {formatPrice(revenueCents, summary.currency, locale)}
            </span>
          </p>
          <p className={styles.muted}>{t('today.revenueHint')}</p>
          <Button variant="secondary" onClick={openDay}>
            {t('today.revenueAction')}
          </Button>
        </section>
      )}
    </div>
  )
}
