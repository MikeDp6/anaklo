import { describe, expect, it } from 'vitest'
import {
  PUSH_BODY_MAX,
  PUSH_LOCALES,
  PUSH_TEMPLATES,
  PUSH_TITLE_MAX,
  pushTemplateVariables,
  renderPush,
  renderPushAllLocales,
  type PushTemplateKey,
} from './push-templates.ts'

const KEYS = Object.keys(PUSH_TEMPLATES) as PushTemplateKey[]

/** The longest value each variable may take; add one here with every new variable. */
const LONGEST: Readonly<Record<string, string>> = {}

describe('push templates', () => {
  it('have the same templates in el and en', () => {
    for (const key of KEYS) {
      expect(Object.keys(PUSH_TEMPLATES[key]).sort()).toEqual([...PUSH_LOCALES].sort())
    }
  })

  it('use the same variables in every language', () => {
    for (const key of KEYS) {
      expect(pushTemplateVariables(key, 'el')).toEqual(pushTemplateVariables(key, 'en'))
    }
  })

  it('render every template with non-empty texts, within the limits and no placeholder left', () => {
    for (const key of KEYS) {
      for (const locale of PUSH_LOCALES) {
        const values = Object.fromEntries(
          pushTemplateVariables(key, locale).map((name) => [name, LONGEST[name] ?? '']),
        )
        for (const name of pushTemplateVariables(key, locale)) {
          expect(LONGEST[name], `longest value for {{${name}}}`).toBeDefined()
        }
        const { title, body } = renderPush(key, locale, values)
        expect(title.trim().length).toBeGreaterThan(0)
        expect(body.trim().length).toBeGreaterThan(0)
        expect(title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX)
        expect(body.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
        expect(`${title}${body}`).not.toMatch(/\{\{|\}\}/)
      }
    }
  })

  it('writes Greek in normal case, not converted like SMS', () => {
    expect(PUSH_TEMPLATES.spike_test.el.title).toBe('Δοκιμαστική ειδοποίηση')
  })

  it('renders all languages at once for OneSignal', () => {
    const texts = renderPushAllLocales('spike_test')
    expect(texts.el.title).toBe(PUSH_TEMPLATES.spike_test.el.title)
    expect(texts.en.body).toBe(PUSH_TEMPLATES.spike_test.en.body)
  })
})
