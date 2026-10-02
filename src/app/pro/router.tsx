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
import { ServicesPage } from '@/features/services/components/ServicesPage'
import { AbsencePage } from '@/features/settings/components/AbsencePage'
import { BookingPolicyPage } from '@/features/settings/components/BookingPolicyPage'
import { ClosuresPage } from '@/features/settings/components/ClosuresPage'
import { ConflictsPage } from '@/features/settings/components/ConflictsPage'
import { ManagerOnly } from '@/features/settings/components/ManagerOnly'
import { SettingsPage } from '@/features/settings/components/SettingsPage'
import { TimeOffPage } from '@/features/settings/components/TimeOffPage'
import { StaffPage } from '@/features/staff/components/StaffPage'
import { WeekHoursPage } from '@/features/staff/components/WeekHoursPage'
import { NotFoundPage } from '../shared/NotFoundPage'
import { LoadingPage } from './LoadingPage'
import { MemberLayout } from './MemberLayout'
import { ProShell } from './ProShell'
import { RouteErrorPage } from './RouteErrorPage'

// Pro app entry (ADR-0002), served under /app with its own manifest. Every signed-in page sits
// under the member route, whose loader checks the session and reads the role live (ADR-0009).
// Settings (contract 1.6 §4.1): the index and «Ειδοποιήσεις» for every role; the shop's
// configuration and the schedule operations only for owner/manager (`ManagerOnly`; the server
// refuses anyone else's writes anyway).
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
            {
              element: <ManagerOnly />,
              children: [
                { path: 'settings/absence', element: <AbsencePage /> },
                { path: 'settings/services', element: <ServicesPage /> },
                { path: 'settings/staff', element: <StaffPage /> },
                { path: 'settings/hours', element: <WeekHoursPage /> },
                { path: 'settings/closures', element: <ClosuresPage /> },
                { path: 'settings/time-off', element: <TimeOffPage /> },
                { path: 'settings/booking-policy', element: <BookingPolicyPage /> },
                { path: 'settings/conflicts', element: <ConflictsPage /> },
              ],
            },
          ],
        },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: '/app' },
)
