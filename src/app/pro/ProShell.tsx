import { Outlet } from 'react-router'
import { InstallPage } from '@/features/auth/components/InstallPage'
import { useNeedsInstall } from '@/features/auth/hooks/useNeedsInstall'
import { useSessionEvents } from '@/features/auth/hooks/useSessionEvents'

/** Root of the pro app: the iOS install gate first, then the session watch around every page. */
export function ProShell() {
  const needsInstall = useNeedsInstall()
  useSessionEvents()
  return needsInstall ? <InstallPage /> : <Outlet />
}
