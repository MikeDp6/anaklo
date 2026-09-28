/**
 * iOS keeps the installed app's storage apart from Safari's: a sign-in in a Safari tab never
 * reaches the Home Screen app, and push works only in the installed app (ADR-0009 §5,
 * ADR-0010). So on iOS, outside the installed app, /app shows install instructions first.
 */
export interface InstallContext {
  readonly isIOS: boolean
  readonly standalone: boolean
}

export function needsInstall({ isIOS, standalone }: InstallContext): boolean {
  return isIOS && !standalone
}

/** The browser facts `detectInstallContext` reads, so tests can pass plain objects. */
export interface InstallEnvironment {
  readonly userAgent: string
  readonly platform: string
  readonly maxTouchPoints: number
  /** Safari's non-standard `navigator.standalone` (true inside a Home Screen app). */
  readonly navigatorStandalone: boolean | undefined
  readonly displayModeStandalone: boolean
}

export function detectInstallContext(env: InstallEnvironment): InstallContext {
  // iPadOS reports itself as a Mac; the touch screen gives it away.
  const isIPadOS = env.platform === 'MacIntel' && env.maxTouchPoints > 1
  return {
    isIOS: /iPad|iPhone|iPod/.test(env.userAgent) || isIPadOS,
    standalone: env.navigatorStandalone === true || env.displayModeStandalone,
  }
}

export function readInstallEnvironment(): InstallEnvironment {
  const nav: Navigator & { standalone?: boolean } = window.navigator
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    navigatorStandalone: nav.standalone,
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
  }
}
