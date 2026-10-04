import { useTranslation } from 'react-i18next'
import { formatPhone } from '@/shared/lib/phone'
import { cx } from '@/shared/ui/cx'
import { useSupportContact } from '../hooks/useSupportContact'
import styles from './mfa.module.css'

/**
 * Nous's contact as `mailto:`/`tel:` links (`VITE_SUPPORT_*`; a missing or malformed value is
 * hidden, and with neither nothing renders). Shared by «Χάσατε τη συσκευή σας;» and «Επικοινώνησε
 * με τη Nous» (contracts 1.7 §6.5, 1.9b §4.3).
 */
export function SupportContactLinks() {
  const { t } = useTranslation('pro')
  const contact = useSupportContact()
  if (!contact.email && !contact.phone) return null
  return (
    <ul className={styles.contacts}>
      {contact.email && (
        <li>
          <a href={`mailto:${contact.email}`} className={cx(styles.link, 'pressable')}>
            {t('mfa.lostDevice.email', { email: contact.email })}
          </a>
        </li>
      )}
      {contact.phone && (
        <li>
          <a href={`tel:${contact.phone}`} className={cx(styles.link, 'pressable')}>
            {t('mfa.lostDevice.phone', { phone: formatPhone(contact.phone) })}
          </a>
        </li>
      )}
    </ul>
  )
}
