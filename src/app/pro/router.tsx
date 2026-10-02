import { createBrowserRouter } from 'react-router'
import { AddDevicePage } from '@/features/auth/components/AddDevicePage'
import { LoginPage } from '@/features/auth/components/LoginPage'
import { LostDevicePage } from '@/features/auth/components/LostDevicePage'
import { MfaChallengePage } from '@/features/auth/components/MfaChallengePage'
import { MfaEnrollPage } from '@/features/auth/components/MfaEnrollPage'
import { NoAccessPage } from '@/features/auth/components/NoAccessPage'
import { SecondDevicePage } from '@/features/auth/components/SecondDevicePage'
import { SecurityPage } from '@/features/auth/components/SecurityPage'
import {
  APP_BASENAME,
  loginLoader,
  MEMBER_ROUTE_ID,
  mfaLoader,
  noAccessLoader,
  requireMembership,
  secondDeviceLoader,
} from '@/features/auth/loaders'
import { DayPage } from '@/features/calendar/components/DayPage'
import { TodayPage } from '@/features/calendar/components/TodayPage'
import { MembersPage } from '@/features/members/components/MembersPage'
import { NotificationsPage } from '@/features/push/components/NotificationsPage'
import { ServicesPage } from '@/features/services/components/ServicesPage'
import { AbsencePage } from '@/features/settings/components/AbsencePage'
import { BookingPolicyPage } from '@/features/settings/components/BookingPolicyPage'
import { ClosuresPage } from '@/features/settings/components/ClosuresPage'
import { ConflictsPage } from '@/features/settings/components/ConflictsPage'
import { IdentityPage } from '@/features/settings/components/IdentityPage'
import { ManagerOnly } from '@/features/settings/components/ManagerOnly'
import { OwnerOnly } from '@/features/settings/components/OwnerOnly'
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
// under the member route, whose loader checks the session, reads the role live and decides the
// second step (ADR-0009 §10, contract 1.7 §6.2): an owner or manager without a device enrols
// (`mfa/enroll`, blocking), with a device but an `aal1` session gives the code (`mfa/challenge`).
// The `mfa/*` screens are siblings of the member route: no tab bar, only «Αποσύνδεση».
// Settings (contracts 1.6 §4.1, 1.7 §6.1): the index, «Ειδοποιήσεις» and «Ασφάλεια» for every
// role; the shop's configuration and the schedule operations for owner/manager (`ManagerOnly`);
// «Μέλη» and «Ταυτότητα επιχείρησης» for the owner (`OwnerOnly`). The server refuses anyone
// else's writes anyway, and asks for a fresh code for the critical ones.
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
          path: 'mfa/enroll',
          element: <MfaEnrollPage />,
          loader: mfaLoader('enroll'),
          errorElement: <RouteErrorPage />,
        },
        {
          path: 'mfa/challenge',
          element: <MfaChallengePage />,
          loader: mfaLoader('challenge'),
          errorElement: <RouteErrorPage />,
        },
        {
          path: 'mfa/lost-device',
          element: <LostDevicePage />,
          loader: mfaLoader('challenge'),
          errorElement: <RouteErrorPage />,
        },
        {
          path: 'mfa/second-device',
          element: <SecondDevicePage />,
          loader: secondDeviceLoader,
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
            { path: 'settings/security', element: <SecurityPage /> },
            { path: 'settings/security/add-device', element: <AddDevicePage /> },
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
            {
              element: <OwnerOnly />,
              children: [
                { path: 'settings/members', element: <MembersPage /> },
                { path: 'settings/identity', element: <IdentityPage /> },
              ],
            },
          ],
        },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: APP_BASENAME },
)
