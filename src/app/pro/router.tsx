import { createBrowserRouter } from 'react-router'
import { LoginPage } from '@/features/auth/components/LoginPage'
import { NoAccessPage } from '@/features/auth/components/NoAccessPage'
import {
  loginLoader,
  MEMBER_ROUTE_ID,
  noAccessLoader,
  requireMembership,
} from '@/features/auth/loaders'
import { DayPage } from '@/features/calendar/components/DayPage'
import { TodayPage } from '@/features/calendar/components/TodayPage'
import { NotificationsPage } from '@/features/push/components/NotificationsPage'
import { SettingsPage } from '@/features/settings/components/SettingsPage'
import { NotFoundPage } from '../shared/NotFoundPage'
import { LoadingPage } from './LoadingPage'
import { MemberLayout } from './MemberLayout'
import { ProShell } from './ProShell'
import { RouteErrorPage } from './RouteErrorPage'

// Pro app entry (ADR-0002), served under /app with its own manifest. Every signed-in page sits
// under the member route, whose loader checks the session and reads the role live (ADR-0009).
export const router = createBrowserRouter(
  [
    {
      element: <ProShell />,
      hydrateFallbackElement: <LoadingPage />,
      errorElement: <RouteErrorPage />,
      children: [
        { path: 'login', element: <LoginPage />, loader: loginLoader },
        {
          path: 'no-access',
          element: <NoAccessPage />,
          loader: noAccessLoader,
          errorElement: <RouteErrorPage />,
        },
        {
          id: MEMBER_ROUTE_ID,
          element: <MemberLayout />,
          loader: requireMembership,
          errorElement: <RouteErrorPage />,
          children: [
            { index: true, element: <TodayPage /> },
            { path: 'day', element: <DayPage /> },
            { path: 'settings', element: <SettingsPage /> },
            { path: 'settings/notifications', element: <NotificationsPage /> },
          ],
        },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: '/app' },
)
