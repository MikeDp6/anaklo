import { describe, expect, it } from 'vitest'
import { createSmsProvider, maskPhone } from './sms-provider.ts'

const MESSAGE = { to: '+306900000001', text: '424242 EINAI O KΩΔIKOΣ ΣOY', segments: 1 }

describe('createSmsProvider', () => {
  it('refuses the fake adapter in prod (second line of defence after the config)', () => {
    expect(() => createSmsProvider({ env: 'prod', provider: 'fake' })).toThrow(/refused in prod/)
  })

  it('never sends: answers ok at no cost with the prepared segments and a fake id', async () => {
    const provider = createSmsProvider({
      env: 'dev',
      provider: 'fake',
      log: () => {
        throw new Error('the fake adapter must not log outside local')
      },
      randomId: () => '00000000-0000-4000-8000-000000000abc',
    })
    expect(provider.name).toBe('fake')
    await expect(provider.send(MESSAGE)).resolves.toEqual({
      ok: true,
      providerMessageId: 'fake-00000000-0000-4000-8000-000000000abc',
      segments: 1,
      costCents: 0,
    })
  })

  it('logs the text with the number masked only when ANAKLO_ENV=local', async () => {
    const lines: string[] = []
    const provider = createSmsProvider({
      env: 'local',
      provider: 'fake',
      log: (line) => lines.push(line),
    })
    const result = await provider.send(MESSAGE)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.providerMessageId).toMatch(/^fake-[0-9a-f-]{36}$/)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('+30690****001')
    expect(lines[0]).toContain(MESSAGE.text)
    expect(lines[0]).not.toContain(MESSAGE.to)
  })
})

describe('maskPhone', () => {
  it('keeps the country prefix and the last three digits only', () => {
    expect(maskPhone('+306900000001')).toBe('+30690****001')
    expect(maskPhone('+447700900123')).toBe('+44770****123')
    expect(maskPhone('+3069')).toBe('****')
  })
})
