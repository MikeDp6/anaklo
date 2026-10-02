import { useTranslation } from 'react-i18next'
import { formatPrice, useAppLocale } from '@/features/calendar/format'
import styles from '@/features/staff/components/settings.module.css'
import { cx } from '@/shared/ui/cx'
import { Skeleton } from '@/shared/ui/Skeleton'
import type { CatalogueService } from '../schema'
import type { ServiceGroup } from '../serviceForm'

/**
 * The catalogue grouped by category (contract 1.6 §4.3): name, «30′ · 13,00 €» and «Μόνο στο
 * κατάστημα» when the service is not bookable online; inactive services in a last group.
 */
export function ServiceList({
  groups,
  currency,
  onOpen,
}: {
  groups: readonly ServiceGroup[]
  currency: string
  onOpen: (service: CatalogueService) => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  if (groups.length === 0) return <p className={styles.muted}>{t('services.empty')}</p>
  return (
    <div className={styles.stack} data-testid="service-list">
      {groups.map((group) => {
        const title =
          group.kind === 'category'
            ? group.category.name
            : group.kind === 'none'
              ? t('services.noCategory')
              : t('services.inactive')
        const key = group.kind === 'category' ? group.category.id : group.kind
        return (
          <section key={key} aria-label={title} className={styles.stack}>
            <h2 className={styles.groupTitle}>{title}</h2>
            <ul className={styles.list}>
              {group.services.map((service) => (
                <li key={service.id}>
                  <button
                    type="button"
                    className={cx(styles.row, 'pressable')}
                    onClick={() => onOpen(service)}
                  >
                    <span className={styles.rowMain}>
                      <span className={styles.rowTitle}>{service.name}</span>
                      <span className={styles.rowMeta}>
                        {t('services.terms', {
                          min: service.durationMin,
                          price: formatPrice(service.priceCents, currency, locale),
                        })}
                      </span>
                      {!service.onlineBookable && (
                        <span className={styles.badge}>{t('services.storeOnly')}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

/** E17 while the catalogue loads: the shape of two groups of rows (no layout shift after). */
export function ServiceListSkeleton() {
  const { t } = useTranslation('pro')
  return (
    <div className={styles.stack} role="status">
      <span className="visually-hidden">{t('services.loading')}</span>
      {[3, 2].map((rows, group) => (
        <div key={group} className={styles.stack}>
          <Skeleton height={18} width="40%" />
          {Array.from({ length: rows }, (_, row) => (
            <Skeleton key={row} height={64} />
          ))}
        </div>
      ))}
    </div>
  )
}
