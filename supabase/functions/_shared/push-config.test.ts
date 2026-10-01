import { describe, expect, it } from 'vitest'
import { parsePushConfig } from './push-config.ts'

const APP_ID = '5f0e0d0c-0000-4000-8000-0000000000aa'
const REST_KEY = 'os_v2_app_testkeynotreal000000000000'

describe('parsePushConfig (contract 1.5 §3.5)', () => {
  it('accepts the fake sender locally and on dev', () => {
    for (const env of ['local', 'dev'] as const) {
      expect(parsePushConfig({ PUSH_PROVIDER: 'fake' }, env)).toEqual({
        ok: true,
        config: { provider: 'fake', oneSignal: null },
      })
    }
  })

  it('refuses the fake sender in prod (ANAKLO_ENV unset counts as prod)', () => {
    expect(parsePushConfig({ PUSH_PROVIDER: 'fake' }, 'prod')).toEqual({
      ok: false,
      problems: ['PUSH_PROVIDER: fake is refused when ANAKLO_ENV is prod (or unset)'],
    })
  })

  it('requires PUSH_PROVIDER; an unresolved env(NAME) counts as unset', () => {
    for (const value of [undefined, '', '  ', 'env(PUSH_PROVIDER)']) {
      expect(parsePushConfig({ PUSH_PROVIDER: value }, 'local')).toEqual({
        ok: false,
        problems: ['PUSH_PROVIDER: required (fake | onesignal)'],
      })
    }
    expect(parsePushConfig({ PUSH_PROVIDER: 'vapid' }, 'local')).toEqual({
      ok: false,
      problems: ['PUSH_PROVIDER: unknown (fake | onesignal)'],
    })
  })

  it('needs both OneSignal keys, and a UUID app id, only for onesignal', () => {
    expect(
      parsePushConfig(
        { PUSH_PROVIDER: 'onesignal', ONESIGNAL_APP_ID: APP_ID, ONESIGNAL_REST_API_KEY: REST_KEY },
        'prod',
      ),
    ).toEqual({
      ok: true,
      config: { provider: 'onesignal', oneSignal: { appId: APP_ID, restApiKey: REST_KEY } },
    })
    const missing = parsePushConfig({ PUSH_PROVIDER: 'onesignal' }, 'dev')
    expect(missing).toEqual({
      ok: false,
      problems: [
        'ONESIGNAL_APP_ID: required when PUSH_PROVIDER is onesignal',
        'ONESIGNAL_REST_API_KEY: required when PUSH_PROVIDER is onesignal',
      ],
    })
    expect(
      parsePushConfig(
        {
          PUSH_PROVIDER: 'onesignal',
          ONESIGNAL_APP_ID: 'my-app',
          ONESIGNAL_REST_API_KEY: REST_KEY,
        },
        'dev',
      ),
    ).toEqual({ ok: false, problems: ['ONESIGNAL_APP_ID: must be a UUID'] })
    // The fake sender ignores keys it does not use.
    expect(parsePushConfig({ PUSH_PROVIDER: 'fake', ONESIGNAL_APP_ID: 'x' }, 'local').ok).toBe(true)
  })

  it('names the variable, never its value', () => {
    const result = parsePushConfig(
      { PUSH_PROVIDER: 'onesignal', ONESIGNAL_APP_ID: 'leaked-app-id', ONESIGNAL_REST_API_KEY: '' },
      'dev',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems.join('\n')).not.toContain('leaked-app-id')
  })
})
