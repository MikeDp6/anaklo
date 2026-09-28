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

await mount(
  <QueryClientProvider client={createQueryClient()}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
  proCatalogues,
)
