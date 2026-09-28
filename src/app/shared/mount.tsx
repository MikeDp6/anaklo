import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, type CatalogueSet } from '@/shared/i18n'

/**
 * Shared start-up for both entries: i18n first (with the namespaces of that entry), then React.
 * Data providers belong to each entry: the pro app wraps TanStack Query around its router; the
 * booking page has none (phase 1 §1.3, budget tactic 3).
 */
export async function mount(app: ReactNode, catalogues: CatalogueSet): Promise<void> {
  await initI18n(catalogues)
  const container = document.getElementById('root')
  if (!container) throw new Error('Missing #root element')
  createRoot(container).render(<StrictMode>{app}</StrictMode>)
}
