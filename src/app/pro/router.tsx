import { createBrowserRouter } from 'react-router'
import { TodayPage } from '@/features/calendar/components/TodayPage'
import { NotFoundPage } from '../shared/NotFoundPage'

// Pro app entry (ADR-0002), served under /app with its own manifest.
export const router = createBrowserRouter(
  [
    { path: '/', element: <TodayPage /> },
    { path: '*', element: <NotFoundPage /> },
  ],
  { basename: '/app' },
)
