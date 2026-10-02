import '@/styles/fonts.css'
import '@/styles/tokens.css'
import '@/styles/base.css'
import '@/shared/motion/motion.css'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router/dom'
import { proCatalogues } from '@/shared/i18n/pro'
import { createQueryClient } from '../shared/queryClient'
import { mount } from '../shared/mount'
import { router } from './router'

// A request refused for the session or the role runs the route guards again (contract 1.7 §6.2).
const queryClient = createQueryClient({ onAuthFailure: () => void router.revalidate() })

await mount(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
  proCatalogues,
)
