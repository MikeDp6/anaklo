import { describe, expect, it } from 'vitest'
import { detectInstallContext, needsInstall, type InstallEnvironment } from './installGate'

describe('needsInstall', () => {
  it.each([
    { isIOS: true, standalone: false, expected: true },
    { isIOS: true, standalone: true, expected: false },
    { isIOS: false, standalone: false, expected: false },
    { isIOS: false, standalone: true, expected: false },
  ])('isIOS=$isIOS standalone=$standalone → $expected', ({ isIOS, standalone, expected }) => {
    expect(needsInstall({ isIOS, standalone })).toBe(expected)
  })
})

describe('detectInstallContext', () => {
  const base: InstallEnvironment = {
    userAgent: '',
    platform: '',
    maxTouchPoints: 0,
    navigatorStandalone: undefined,
    displayModeStandalone: false,
  }
  const iPhone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const android =
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'
  const mac =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

  it('an iPhone in a Safari tab must install first', () => {
    const context = detectInstallContext({ ...base, userAgent: iPhone, platform: 'iPhone' })
    expect(context).toEqual({ isIOS: true, standalone: false })
    expect(needsInstall(context)).toBe(true)
  })

  it('the installed iPhone app (navigator.standalone) goes on', () => {
    const context = detectInstallContext({ ...base, userAgent: iPhone, navigatorStandalone: true })
    expect(needsInstall(context)).toBe(false)
  })

  it('display-mode standalone also counts as installed', () => {
    const context = detectInstallContext({
      ...base,
      userAgent: iPhone,
      displayModeStandalone: true,
    })
    expect(needsInstall(context)).toBe(false)
  })

  it('iPadOS, which reports itself as a Mac with a touch screen, is iOS', () => {
    const context = detectInstallContext({
      ...base,
      userAgent: mac,
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })
    expect(context.isIOS).toBe(true)
  })

  it('a desktop Mac and an Android phone are not gated', () => {
    expect(detectInstallContext({ ...base, userAgent: mac, platform: 'MacIntel' }).isIOS).toBe(
      false,
    )
    expect(needsInstall(detectInstallContext({ ...base, userAgent: android }))).toBe(false)
  })
})
