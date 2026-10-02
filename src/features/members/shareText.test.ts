import i18next from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n, setLocale } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { appUrl, shareText } from './shareText'

beforeAll(async () => {
  await initI18n(proCatalogues)
})

describe('appUrl', () => {
  it.each([
    ['https://dev.anaklo.gr', 'https://dev.anaklo.gr/app/'],
    ['http://localhost:5173/', 'http://localhost:5173/app/'],
  ])('%s → %s', (origin, expected) => {
    expect(appUrl(origin)).toBe(expected)
  })
})

describe('shareText (contract 1.7 §6.8)', () => {
  it('names the shop, the app address, the home screen and the email; no code, no token', () => {
    const t = i18next.getFixedT('el', 'pro')
    expect(
      shareText(t, {
        businessName: 'Demo Barber',
        appName: 'Anaklo',
        email: 'new@example.test',
        appUrl: 'https://dev.anaklo.gr/app/',
      }),
    ).toBe(
      'Σε πρόσθεσα στο Demo Barber στο Anaklo. Άνοιξε το https://dev.anaklo.gr/app/ στο κινητό σου, πρόσθεσέ το στην αρχική οθόνη και μπες με το email new@example.test: θα σου έρθει κωδικός.',
    )
  })

  it('in English too', async () => {
    await setLocale('en')
    try {
      const t = i18next.getFixedT('en', 'pro')
      expect(
        shareText(t, {
          businessName: 'Demo Barber',
          appName: 'Anaklo',
          email: 'new@example.test',
          appUrl: 'https://dev.anaklo.gr/app/',
        }),
      ).toBe(
        'I added you to Demo Barber on Anaklo. Open https://dev.anaklo.gr/app/ on your phone, add it to your home screen and sign in with the email new@example.test: you will get a code.',
      )
    } finally {
      await setLocale('el')
    }
  })
})
