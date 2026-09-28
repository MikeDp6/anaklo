import { useTranslation } from 'react-i18next'
import { themeSurface } from '@/shared/lib/theme'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { Framed } from '@/shared/ui/Framed'
import { cx } from '@/shared/ui/cx'
import type { CatalogueBusiness } from '../schema'
import { Reveal } from './Reveal'
import styles from './CoverCard.module.css'

/**
 * The cover of the booking page: G5/E8 offset frame, G1 label (E3) and the business name as a
 * large Didot title rising word by word (G2 + E5; it is the LCP and never waits for the font or
 * the motion to be readable). A theme with `surface: dark` turns it into the G6 dark hero
 * (no photo in Phase 1: the dark surface under the scrim, text in the solid bottom half).
 */
export function CoverCard({ business }: { business: CatalogueBusiness }) {
  const { t } = useTranslation('booking')
  const dark = themeSurface(business.theme) === 'dark'
  return (
    <Framed className={styles.frame}>
      <div className={cx(styles.cover, dark && styles.dark)} data-surface={dark ? 'dark' : 'light'}>
        <Eyebrow onDark={dark} reveal>
          {t('cover.eyebrow')}
        </Eyebrow>
        <DisplayTitle as="h1" size="xl" onDark={dark} animate>
          {business.name}
        </DisplayTitle>
        {business.address && (
          <Reveal as="p" className={styles.address}>
            {business.address}
          </Reveal>
        )}
      </div>
    </Framed>
  )
}
