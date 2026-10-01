import { describe, expect, it } from 'vitest'
import {
  appUrl,
  buildPushPayload,
  ONESIGNAL_NOTIFICATIONS_URL,
  OneSignalSubscriptionId,
  pushClickUrl,
  SubscriptionIdBody,
} from './onesignal.ts'
import { renderPushAllLocales } from './push-templates.ts'

const APP_ID = '5f0e0d0c-0000-4000-8000-0000000000aa'
const DEVICE = '8b1f6a52-3c1e-4c0d-9a4e-2f7d1c9b0e11'
const OTHER_DEVICE = '0c7e1d2a-9b4f-4e3a-8d6c-5a1b2c3d4e5f'
const texts = renderPushAllLocales('push_test')

describe('buildPushPayload (ADR-0010 §2)', () => {
  it('targets the given subscriptions only, on the push channel, with el and en texts', () => {
    const payload = buildPushPayload({ appId: APP_ID, subscriptionIds: [DEVICE], texts })
    expect(payload).toEqual({
      app_id: APP_ID,
      target_channel: 'push',
      include_subscription_ids: [DEVICE],
      headings: { en: texts.en.title, el: texts.el.title },
      contents: { en: texts.en.body, el: texts.el.body },
    })
  })

  it('never addresses a user identity: no external_id, aliases or segments', () => {
    const payload = buildPushPayload({
      appId: APP_ID,
      subscriptionIds: [DEVICE, OTHER_DEVICE],
      texts,
      url: 'https://dev.anaklo.gr/app/',
    })
    const keys = Object.keys(payload).sort()
    expect(keys).toEqual([
      'app_id',
      'contents',
      'headings',
      'include_subscription_ids',
      'target_channel',
      'url',
    ])
    const serialised = JSON.stringify(payload)
    for (const forbidden of [
      'external_id',
      'include_aliases',
      'include_external_user_ids',
      'include_player_ids',
      'included_segments',
      'filters',
    ]) {
      expect(serialised).not.toContain(forbidden)
    }
  })

  it('sends each subscription once', () => {
    const payload = buildPushPayload({
      appId: APP_ID,
      subscriptionIds: [DEVICE, DEVICE, OTHER_DEVICE],
      texts,
    })
    expect(payload.include_subscription_ids).toEqual([DEVICE, OTHER_DEVICE])
  })

  it('refuses no recipient, an id that is not a subscription id, and a missing app id', () => {
    expect(() => buildPushPayload({ appId: APP_ID, subscriptionIds: [], texts })).toThrow()
    for (const notAnId of ['00000000-0000-4000-8000-00000000a001x', 'owner@demo.test', '']) {
      expect(() => buildPushPayload({ appId: APP_ID, subscriptionIds: [notAnId], texts })).toThrow(
        /subscription ids/,
      )
    }
    expect(() => buildPushPayload({ appId: ' ', subscriptionIds: [DEVICE], texts })).toThrow()
  })

  it('adds the tap url only when there is one', () => {
    expect(
      buildPushPayload({ appId: APP_ID, subscriptionIds: [DEVICE], texts, url: null }),
    ).not.toHaveProperty('url')
    expect(
      buildPushPayload({
        appId: APP_ID,
        subscriptionIds: [DEVICE],
        texts,
        url: 'https://dev.anaklo.gr/app/',
      }).url,
    ).toBe('https://dev.anaklo.gr/app/')
  })

  it('posts to the push channel of the notifications endpoint', () => {
    expect(ONESIGNAL_NOTIFICATIONS_URL).toBe('https://api.onesignal.com/notifications?c=push')
  })
})

describe('subscription id schemas', () => {
  it('accept a UUID and nothing else', () => {
    expect(OneSignalSubscriptionId.safeParse(DEVICE).success).toBe(true)
    for (const bad of ['', 'abc', `${DEVICE} `, 42, null]) {
      expect(OneSignalSubscriptionId.safeParse(bad).success).toBe(false)
    }
  })

  it('the body carries exactly one subscription id', () => {
    expect(SubscriptionIdBody.safeParse({ subscription_id: DEVICE }).success).toBe(true)
    expect(SubscriptionIdBody.safeParse({}).success).toBe(false)
    expect(
      SubscriptionIdBody.safeParse({ subscription_id: DEVICE, external_id: 'owner' }).success,
    ).toBe(false)
  })
})

describe('pushClickUrl', () => {
  it.each([
    ['https://dev.anaklo.gr', 'https://dev.anaklo.gr/app/'],
    ['http://localhost:5173', 'http://localhost:5173/app/'],
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5173/app/'],
    ['http://dev.anaklo.gr', null],
    ['javascript:alert(1)', null],
    ['not a url', null],
    [null, null],
  ] as const)('%s → %s', (origin, expected) => {
    expect(pushClickUrl(origin)).toBe(expected)
  })
})

describe('appUrl (the tap of a server-sent push, contract 1.5 §3.2)', () => {
  it.each([
    ['localhost:5173', 'http://localhost:5173/app/'],
    ['127.0.0.1:5173', 'http://127.0.0.1:5173/app/'],
    ['localhost', 'http://localhost/app/'],
    ['dev.anaklo.gr', 'https://dev.anaklo.gr/app/'],
    ['anaklo.gr', 'https://anaklo.gr/app/'],
    // a public host that only starts like a local one is still https
    ['localhost.anaklo.gr', 'https://localhost.anaklo.gr/app/'],
  ] as const)('%s → %s', (siteHost, expected) => {
    expect(appUrl(siteHost)).toBe(expected)
  })
})
