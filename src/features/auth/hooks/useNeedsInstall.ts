import { useState } from 'react'
import { detectInstallContext, needsInstall, readInstallEnvironment } from '../installGate'

/** Decided once per page load: installing the app always opens a new page. */
export function useNeedsInstall(): boolean {
  const [value] = useState(() => needsInstall(detectInstallContext(readInstallEnvironment())))
  return value
}
