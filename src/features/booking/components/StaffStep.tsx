import { useTranslation } from 'react-i18next'
import { onColor } from '@/shared/lib/theme'
import { cx } from '@/shared/ui/cx'
import { initialOf, staffForService, termsFor } from '../catalogue'
import type { BookingFlow } from '../flow/useBookingFlow'
import { formatPrice } from '../format'
import type { CatalogueStaff } from '../schema'
import { StaffCarousel } from './StaffCarousel'
import { StepSection } from './StepSection'
import styles from './steps.module.css'

/** More than this many staff members: the E12 carousel instead of a list. */
const CAROUSEL_FROM = 5
const HEX = /^#[0-9A-Fa-f]{6}$/

/** Step 2, only with ≥ 2 staff for the service. «Anyone» only with `allow_any_staff`. */
export function StaffStep({ flow }: { flow: BookingFlow }) {
  const { t } = useTranslation('booking')
  const { catalogue, state, dispatch, locale } = flow
  const serviceId = state.serviceId ?? ''
  const staff = staffForService(catalogue, serviceId)
  const currency = catalogue.business.currency
  const choose = (staffId: string | null) => dispatch({ type: 'staff', staffId })

  const meta = (member: CatalogueStaff) => {
    const terms = termsFor(catalogue, serviceId, member.id)
    if (!terms) return ''
    const duration = t('units.minutes', { count: terms.duration_min })
    return `${duration} · ${formatPrice(terms.price_cents, currency, locale)}`
  }

  const option = (member: CatalogueStaff) => {
    const color = member.color && HEX.test(member.color) ? member.color : null
    return (
      <button
        type="button"
        className={cx(styles.option, 'pressable')}
        data-selected={state.staffId === member.id}
        onClick={() => choose(member.id)}
      >
        <span
          className={styles.avatar}
          aria-hidden="true"
          style={color ? { background: color, color: onColor(color) } : undefined}
        >
          {initialOf(member.display_name)}
        </span>
        <span className={styles.optionBody}>
          <span className={styles.optionName}>{member.display_name}</span>
          <span className={styles.optionMeta}>{meta(member)}</span>
        </span>
        <span className={styles.chevron} aria-hidden="true" />
      </button>
    )
  }

  const anyone = catalogue.business.allow_any_staff && (
    <button type="button" className={cx(styles.option, 'pressable')} onClick={() => choose(null)}>
      <span className={styles.optionBody}>
        <span className={styles.optionName}>{t('staff.any')}</span>
        <span className={styles.optionMeta}>{t('staff.anyHint')}</span>
      </span>
      <span className={styles.chevron} aria-hidden="true" />
    </button>
  )

  return (
    <StepSection direction={state.direction} eyebrow={t('staff.eyebrow')} title={t('staff.title')}>
      {staff.length >= CAROUSEL_FROM ? (
        <>
          {anyone && <div className={styles.options}>{anyone}</div>}
          <StaffCarousel items={staff.map((member) => ({ id: member.id, node: option(member) }))} />
        </>
      ) : (
        <ul className={styles.options}>
          {anyone && <li>{anyone}</li>}
          {staff.map((member) => (
            <li key={member.id}>{option(member)}</li>
          ))}
        </ul>
      )}
    </StepSection>
  )
}
