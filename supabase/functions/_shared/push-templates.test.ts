import { describe, expect, it } from 'vitest'
import {
  capPushValue,
  isPushTemplateKey,
  PUSH_BODY_MAX,
  PUSH_CLIENT_FALLBACK,
  PUSH_LOCALES,
  PUSH_TEMPLATE_KEYS,
  PUSH_TEMPLATES,
  PUSH_TITLE_MAX,
  PUSH_VARIABLE_LIMITS,
  pushTemplateVariables,
  renderPush,
  renderPushAllLocales,
  type PushVariable,
} from './push-templates.ts'

/** Every variable at its limit (contract 1.5 §3.2), Greek with accents where it is longest. */
const LONGEST: Readonly<Record<PushVariable, string>> = {
  client: 'Αγγελική-Ευφροσύνη Α'.slice(0, PUSH_VARIABLE_LIMITS.client),
  service: 'Κούρεμα + γένια + περιποίηση φρυδ'.slice(0, PUSH_VARIABLE_LIMITS.service),
  staff: 'Παναγιώτης-Χρυσόστομ'.slice(0, PUSH_VARIABLE_LIMITS.staff),
  date: 'Τετ 30/09',
  time: '23:45',
  business: 'Κομμωτήριο Ομορφιάς Αγία Παρασκευή'.slice(0, PUSH_VARIABLE_LIMITS.business),
}

describe('push templates', () => {
  it('are exactly the push templates of messages_log', () => {
    expect([...PUSH_TEMPLATE_KEYS].sort()).toEqual([
      'push_booking_cancelled',
      'push_booking_created',
      'push_booking_moved',
      'push_security_alert',
      'push_test',
    ])
    expect(isPushTemplateKey('push_test')).toBe(true)
    expect(isPushTemplateKey('spike_test')).toBe(false)
    expect(isPushTemplateKey('booking_confirmed')).toBe(false)
  })

  it('have the same templates in el and en', () => {
    for (const key of PUSH_TEMPLATE_KEYS) {
      expect(Object.keys(PUSH_TEMPLATES[key]).sort()).toEqual([...PUSH_LOCALES].sort())
    }
  })

  it('use the same variables in every language, all of them known and capped', () => {
    for (const key of PUSH_TEMPLATE_KEYS) {
      expect(pushTemplateVariables(key, 'el')).toEqual(pushTemplateVariables(key, 'en'))
      for (const name of pushTemplateVariables(key, 'el')) {
        expect(Object.keys(PUSH_VARIABLE_LIMITS), `limit for {{${name}}}`).toContain(name)
      }
    }
  })

  it('use test values at exactly the limits', () => {
    for (const [name, value] of Object.entries(LONGEST)) {
      expect(Array.from(value), name).toHaveLength(PUSH_VARIABLE_LIMITS[name as PushVariable])
    }
  })

  it('render every template within the limits with the longest values, no placeholder left', () => {
    for (const key of PUSH_TEMPLATE_KEYS) {
      for (const locale of PUSH_LOCALES) {
        const { title, body } = renderPush(key, locale, LONGEST)
        expect(title.trim().length).toBeGreaterThan(0)
        expect(body.trim().length).toBeGreaterThan(0)
        expect(title.length, `${key} ${locale} title`).toBeLessThanOrEqual(PUSH_TITLE_MAX)
        expect(body.length, `${key} ${locale} body`).toBeLessThanOrEqual(PUSH_BODY_MAX)
        expect(`${title}${body}`).not.toMatch(/\{\{|\}\}/)
      }
    }
  })

  it('never carry a phone, an amount or a surname variable', () => {
    for (const key of PUSH_TEMPLATE_KEYS) {
      for (const name of pushTemplateVariables(key, 'el')) {
        expect(['client', 'service', 'date', 'time', 'staff', 'business']).toContain(name)
      }
    }
  })

  it('the security alert (1.9) names the business only, capped at 32', () => {
    expect(PUSH_VARIABLE_LIMITS.business).toBe(32)
    expect(pushTemplateVariables('push_security_alert', 'el')).toEqual(['business'])
    expect(pushTemplateVariables('push_security_alert', 'en')).toEqual(['business'])
    const texts = renderPushAllLocales('push_security_alert', {
      el: { business: 'Κουρείο Demo' },
      en: { business: 'Κουρείο Demo' },
    })
    expect(texts.el).toEqual({
      title: 'Ειδοποίηση ασφαλείας',
      body: 'Κουρείο Demo: μια συσκευή κωδικών άλλαξε χωρίς έγκριση. Δες το email σου.',
    })
    expect(texts.en).toEqual({
      title: 'Security alert',
      body: 'Κουρείο Demo: an authenticator device changed without approval. Check your email.',
    })
    // Never what changed, which member or which device: the email carries that.
    for (const locale of PUSH_LOCALES) {
      const { title, body } = PUSH_TEMPLATES.push_security_alert[locale]
      expect(`${title} ${body}`).not.toMatch(/totp|mfa|2fa|http|www\.|@/i)
    }
  })

  it('writes Greek in normal case, not converted like SMS', () => {
    expect(PUSH_TEMPLATES.push_test.el.title).toBe('Δοκιμαστική ειδοποίηση')
    expect(PUSH_TEMPLATES.push_booking_created.el.title).toBe('Νέα κράτηση')
  })

  it('renders all languages at once, each with its own values', () => {
    const texts = renderPushAllLocales('push_booking_cancelled', {
      el: { client: PUSH_CLIENT_FALLBACK.el, date: 'Τετ 30/09', time: '10:00', staff: 'Νίκος' },
      en: { client: PUSH_CLIENT_FALLBACK.en, date: 'Wed 30/09', time: '10:00', staff: 'Νίκος' },
    })
    expect(texts.el).toEqual({
      title: 'Ακύρωση ραντεβού',
      body: 'Πελάτης · Τετ 30/09 10:00 με Νίκος',
    })
    expect(texts.en).toEqual({
      title: 'Appointment cancelled',
      body: 'Client · Wed 30/09 10:00 with Νίκος',
    })
    // push_test has no variables: nothing to pass.
    expect(renderPushAllLocales('push_test').en.body).toBe(PUSH_TEMPLATES.push_test.en.body)
  })

  it('fails loudly when a variable is missing', () => {
    expect(() => renderPush('push_booking_created', 'el', { client: 'Γιώργος' })).toThrow(
      /needs \{\{/,
    )
  })
})

describe('capPushValue', () => {
  it('keeps short values, trims, and cuts long ones with … within the limit', () => {
    expect(capPushValue('  Νίκος ', 20)).toBe('Νίκος')
    const cut = capPushValue('Παναγιώτης Κωνσταντινόπουλος', 20)
    expect(Array.from(cut)).toHaveLength(20)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.startsWith('Παναγιώτης Κωνσταντ')).toBe(true)
  })

  it('never splits an emoji', () => {
    const cut = capPushValue('😀😀😀😀😀', 3)
    expect(cut).toBe('😀😀…')
  })
})
