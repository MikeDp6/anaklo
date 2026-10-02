import { Outlet } from 'react-router'
import { InstallPage } from '@/features/auth/components/InstallPage'
import { StepUpProvider } from '@/features/auth/components/StepUpProvider'
import { useNeedsInstall } from '@/features/auth/hooks/useNeedsInstall'
import { useSessionEvents } from '@/features/auth/hooks/useSessionEvents'

/**
 * Root of the pro app: the iOS install gate first, then the session watch and the code sheet of
 * critical actions (contract 1.7 §6.6) around every page.
 */
export function ProShell() {
  const needsInstall = useNeedsInstall()
  useSessionEvents()
  if (needsInstall) return <InstallPage />
  return (
    <StepUpProvider>
      <Outlet />
    </StepUpProvider>
  )
}
