import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/shared/i18n'
import { createQueryClient } from './queryClient'

/** Shared start-up for both entries: i18n first, then React with TanStack Query. */
export async function mount(app: ReactNode): Promise<void> {
  await initI18n()
  const container = document.getElementById('root')
  if (!container) throw new Error('Missing #root element')
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>{app}</QueryClientProvider>
    </StrictMode>,
  )
}
