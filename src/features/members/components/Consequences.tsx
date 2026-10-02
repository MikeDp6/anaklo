import { useTranslation } from 'react-i18next'
import type { RoleConsequence } from '../schema'
import own from './members.module.css'

/** What a member change does, written before the button that makes it (contract 1.7 §6.8). */
export function Consequences({ items }: { items: readonly RoleConsequence[] }) {
  const { t } = useTranslation('pro')
  if (items.length === 0) return null
  return (
    <ul className={own.consequences}>
      {items.map((item) => (
        <li key={item}>{t(`members.consequences.${item}`)}</li>
      ))}
    </ul>
  )
}
