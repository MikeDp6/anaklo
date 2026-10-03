import { useTranslation } from 'react-i18next'
import { cx } from '@/shared/ui/cx'
import { ringGeometry, RING_RADIUS, RING_SIZE, RING_STROKE } from '../ring'
import type { ClientRing } from '../schema'
import { useRingText } from '../hooks/useRingText'
import styles from './RhythmRing.module.css'

const CENTRE = RING_SIZE / 2

/**
 * E18 «Δαχτυλίδι ρυθμού» (contract 1.8 §4.4, MOTION.md E18): days since the last visit against
 * the shop's usual interval, as the server computed them (rule 13). The progress circle fills
 * from empty to its final offset once (`ring-progress` of motion.css: `stroke-dashoffset` only);
 * with reduced motion it is drawn at its final offset at once. Without an interval there is no
 * progress circle. The whole ring is one image named by its sentence.
 */
export function RhythmRing({ ring }: { ring: ClientRing }) {
  const { t } = useTranslation('pro')
  const text = useRingText(ring)
  const { circumference, offset } = ringGeometry(ring.fraction)
  const days = ring.daysSinceLast
  return (
    <div
      className={styles.ring}
      role="img"
      aria-label={t('clients.ring.aria', { label: t('clients.ring.label'), text: text.full })}
      data-state={ring.state}
    >
      <svg
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        width={RING_SIZE}
        height={RING_SIZE}
        aria-hidden="true"
        focusable="false"
      >
        <g transform={`rotate(-90 ${CENTRE} ${CENTRE})`}>
          <circle
            className={styles.track}
            cx={CENTRE}
            cy={CENTRE}
            r={RING_RADIUS}
            strokeWidth={RING_STROKE}
          />
          {ring.fraction !== null && (
            <circle
              className={cx('ring-progress', styles.progress)}
              cx={CENTRE}
              cy={CENTRE}
              r={RING_RADIUS}
              strokeWidth={RING_STROKE}
              style={{ '--circ': circumference, '--ring-to': offset }}
            />
          )}
        </g>
      </svg>
      <span className={styles.centre} aria-hidden="true">
        <span className={styles.days}>{days ?? '—'}</span>
        {days !== null && (
          <span className={styles.unit}>{t('clients.ring.daysUnit', { count: days })}</span>
        )}
      </span>
    </div>
  )
}
