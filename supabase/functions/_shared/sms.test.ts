import { describe, expect, it } from 'vitest'
import {
  analyzeSms,
  clipForSms,
  gsm7Septets,
  prepareSms,
  SMS_VARIABLE_LIMITS,
  toGsm7Text,
} from './sms.ts'
import {
  renderSms,
  SMS_TEMPLATES,
  templateVariables,
  type SmsLocale,
  type SmsTemplateKey,
} from './sms-templates.ts'

describe('toGsm7Text', () => {
  it('upper-cases Greek and removes accents', () => {
    expect(toGsm7Text('Γιώργος')).toBe('ΓIΩPΓOΣ')
    expect(toGsm7Text('ραντεβού')).toBe('PANTEBOY')
    expect(toGsm7Text('Ϊούλιος ΐ')).toBe('IOYΛIOΣ I')
  })

  it('maps look-alike capitals to Latin and keeps the GSM-7 Greek ones', () => {
    const out = toGsm7Text('ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ ΓΔΘΛΞΠΣΦΨΩ')
    expect(out).toBe('ABEZHIKMNOPTYX ΓΔΘΛΞΠΣΦΨΩ')
    expect(gsm7Septets(out)).toBe(out.length)
  })

  it('never touches Latin text: links and case-sensitive tokens survive', () => {
    const link = 'anaklo.gr/m/AbCdEf_GhIj-KlMnOpQrStUv'
    expect(toGsm7Text(`Αλλαγή: ${link}`)).toBe(`AΛΛAΓH: ${link}`)
  })

  it('replaces smart punctuation with GSM-7 equivalents', () => {
    expect(toGsm7Text('«Γεια» – δες… ’εδώ’')).toBe('"ΓEIA" - ΔEΣ... \'EΔΩ\'')
  })
})

describe('analyzeSms', () => {
  it('counts GSM-7 septets with extension characters as two', () => {
    expect(gsm7Septets('ABC')).toBe(3)
    expect(gsm7Septets('€')).toBe(2)
    expect(gsm7Septets('[x]')).toBe(5)
  })

  it('reports lower-case Greek as UCS-2 (the thing we avoid)', () => {
    const text = 'Το ραντεβού σου είναι την Τρίτη 17:30. Για ακύρωση πάτα το link παρακάτω.'
    expect(analyzeSms(text)).toMatchObject({ encoding: 'UCS-2', segments: 2 })
    expect(prepareSms(text)).toMatchObject({ encoding: 'GSM-7', segments: 1 })
  })

  it('uses 160/153 for GSM-7 and 70/67 for UCS-2', () => {
    expect(analyzeSms('A'.repeat(160)).segments).toBe(1)
    expect(analyzeSms('A'.repeat(161)).segments).toBe(2)
    expect(analyzeSms('ά'.repeat(70)).segments).toBe(1)
    expect(analyzeSms('ά'.repeat(71)).segments).toBe(2)
  })
})

describe('prepareSms', () => {
  it('forces anything left over into GSM-7 and reports it', () => {
    const result = prepareSms('Γεια 😀 Иван')
    expect(result.encoding).toBe('GSM-7')
    expect(result.replaced).toEqual(['😀', 'И', 'в', 'а', 'н'])
    expect(result.text).toBe('ΓEIA ? ????')
  })
})

describe('clipForSms', () => {
  it('clips names to their septet budget, in GSM-7 form', () => {
    const clipped = clipForSms('staff', 'Παναγιώτης Κωνσταντινόπουλος')
    expect(gsm7Septets(clipped)).toBe(SMS_VARIABLE_LIMITS.staff)
    expect(clipped.startsWith('ΠANAΓIΩTHΣ')).toBe(true)
  })

  it('counts extension characters as two septets and … as three', () => {
    const clipped = clipForSms('staff', '[Barber]…€€€€€€€€€€')
    expect(gsm7Septets(clipped)).toBeLessThanOrEqual(SMS_VARIABLE_LIMITS.staff)
    expect(clipped.startsWith('[Barber]...')).toBe(true)
  })

  it('refuses to clip links, codes, dates and times', () => {
    expect(() => clipForSms('link', `anaklo.gr/m/${'x'.repeat(60)}`)).toThrow(RangeError)
    expect(() => clipForSms('date', 'Τετάρτη 30/12/2026')).toThrow(RangeError)
    expect(() => clipForSms('time', '23:45:00')).toThrow(RangeError)
  })
})

describe('Greek punctuation', () => {
  it('turns the ano teleia (U+0387 and its NFC form U+00B7) into a semicolon', () => {
    expect(toGsm7Text(`α${String.fromCodePoint(0x0387)}β`)).toBe('A;B')
    expect(toGsm7Text(`α${String.fromCodePoint(0x00b7)}β`)).toBe('A;B')
  })
})

// Worst case: every variable at its maximum length, Greek names with accents, a mixed-case token.
const LONGEST: Record<keyof typeof SMS_VARIABLE_LIMITS, string> = {
  business: 'Κουρείο Ωραίο Παναγιώτης'
    .padEnd(SMS_VARIABLE_LIMITS.business, 'ώ')
    .slice(0, SMS_VARIABLE_LIMITS.business),
  staff: 'Παναγιώτης-Χρυσό'.slice(0, SMS_VARIABLE_LIMITS.staff),
  client: 'Αγγελική-Ευφροσύνη'.slice(0, SMS_VARIABLE_LIMITS.client),
  date: 'Τετ 30/12',
  time: '23:45',
  link: `anaklo.gr/m/${'AbCdEfGhIjKlMnOpQrStUvWxYz0123'.slice(0, SMS_VARIABLE_LIMITS.link - 12)}`,
  code: '123456',
  domain: 'booking.anaklo.gr.xy',
}

// Worst case with costly characters: extension characters (2 septets) and '…' (3) in the names.
const COSTLY: Record<keyof typeof SMS_VARIABLE_LIMITS, string> = {
  ...LONGEST,
  business: '[Κουρείο] €€€ {Ωραίο}… | Παναγιώτης ^^',
  staff: '€€€€€€€€€€€€',
  client: '[[[[[[[[[[[[',
}

describe('SMS templates', () => {
  it('uses test values at the exact budgets', () => {
    for (const [name, value] of Object.entries(LONGEST)) {
      expect(gsm7Septets(toGsm7Text(value)), name).toBe(
        SMS_VARIABLE_LIMITS[name as keyof typeof LONGEST],
      )
    }
  })

  const cases = (Object.keys(SMS_TEMPLATES) as SmsTemplateKey[]).flatMap((key) =>
    (['el', 'en'] as SmsLocale[]).map((locale) => [key, locale] as const),
  )

  it.each(cases)('%s (%s) fits one GSM-7 SMS with the longest values', (key, locale) => {
    const sms = renderSms(key, locale, LONGEST)
    expect(sms.encoding).toBe('GSM-7')
    expect(sms.replaced).toEqual([])
    expect(sms.units).toBeLessThanOrEqual(160)
    expect(sms.segments).toBe(1)
  })

  it.each(cases)(
    '%s (%s) still fits one SMS when names contain costly characters',
    (key, locale) => {
      const sms = renderSms(key, locale, COSTLY)
      expect(sms.encoding).toBe('GSM-7')
      expect(sms.segments).toBe(1)
    },
  )

  it.each(cases)('%s (%s) delivers links and codes byte-for-byte', (key, locale) => {
    const sms = renderSms(key, locale, LONGEST)
    const variables = templateVariables(key, locale)
    if (variables.includes('link')) expect(sms.text).toContain(LONGEST.link)
    if (variables.includes('code')) expect(sms.text).toContain(LONGEST.code)
    if (variables.includes('domain'))
      expect(sms.text).toContain(`@${LONGEST.domain} #${LONGEST.code}`)
  })

  it('fails loudly when a variable is missing', () => {
    expect(() => renderSms('reminder', 'el', { business: 'X' })).toThrow(/needs \{\{date\}\}/)
  })
})
