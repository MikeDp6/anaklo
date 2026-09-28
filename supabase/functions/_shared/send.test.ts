// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toBase64Url } from './base64url.ts'
import type { Log, LogValue, Rpc, RpcResult } from './booking-rpc.ts'
import { formatInZone } from './dates.ts'
import {
  manageLink,
  messageVariables,
  sendMessages,
  shortLink,
  SMS_DATE_PATTERN,
  type ClaimedMessage,
  type SendConfig,
} from './send.ts'
import { gsm7Septets, SMS_VARIABLE_LIMITS, toGsm7Text } from './sms.ts'
import type { SmsProvider, SmsSendRequest, SmsSendResult } from './sms-provider.ts'

const MESSAGE_ID = '6b0e8f3c-1a2d-4e5f-8a9b-0c1d2e3f4a5b'
const OTHER_ID = '7c1f9a4d-2b3e-4f60-9bac-1d2e3f4a5b6c'
const LEASE_ID = '8d2a0b5e-3c4f-4a71-8cbd-2e3f4a5b6c7d'
const PHONE = '+306900000001'
const TOKEN = toBase64Url(new Uint8Array(16).fill(250)) // 22 chars, with '-' and '_'

const CONFIG: SendConfig = {
  siteHost: 'localhost:5173',
  smsDomain: 'localhost',
  allowedRecipients: new Set(),
}

function row(overrides: Partial<ClaimedMessage> = {}): ClaimedMessage {
  return {
    id: MESSAGE_ID,
    lease_id: LEASE_ID,
    to_e164: PHONE,
    locale: 'el',
    template: 'booking_confirmed',
    business_name: 'Κουρείο Demo',
    short_code: 'demo01',
    timezone: 'Europe/Athens',
    starts_at: '2026-10-06T07:00:00+00:00',
    staff_name: 'Νίκος',
    manage_token: TOKEN,
    ...overrides,
  }
}

type Call = { fn: string; args: Readonly<Record<string, unknown>> }

function fakeRpc(claimed: unknown[] | RpcResult, recordResult: RpcResult = ok(true)) {
  const calls: Call[] = []
  const rpc: Rpc = (fn, args) => {
    calls.push({ fn, args })
    if (fn === 'claim_messages') {
      return Promise.resolve(Array.isArray(claimed) ? ok(claimed) : claimed)
    }
    if (fn === 'record_send_result') return Promise.resolve(recordResult)
    return Promise.reject(new Error(`unexpected rpc ${fn}`))
  }
  const records = () => calls.filter((call) => call.fn === 'record_send_result').map((c) => c.args)
  return { rpc, calls, records }
}

function ok(data: unknown): RpcResult {
  return { data, error: null }
}

function fakeProvider(answer: SmsSendResult | Error = okSend()) {
  const sent: SmsSendRequest[] = []
  const provider: SmsProvider = {
    name: 'fake',
    send(message) {
      sent.push(message)
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
  }
  return { provider, sent }
}

function okSend(): SmsSendResult {
  return { ok: true, providerMessageId: 'fake-1', segments: 1, costCents: 0 }
}

function recordingLog() {
  const lines: Array<{ event: string; fields: Readonly<Record<string, LogValue>> }> = []
  const log: Log = (event, fields) => lines.push({ event, fields })
  return { log, lines }
}

describe('sendMessages', () => {
  it('claims, renders in the client language and zone, sends and records the result', async () => {
    const db = fakeRpc([row()])
    const { provider, sent } = fakeProvider()
    const { log } = recordingLog()

    const outcomes = await sendMessages({
      rpc: db.rpc,
      provider,
      config: CONFIG,
      ids: [MESSAGE_ID],
      log,
    })

    expect(outcomes).toEqual({ [MESSAGE_ID]: 'sent' })
    expect(db.calls[0]).toEqual({ fn: 'claim_messages', args: { p_ids: [MESSAGE_ID] } })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(PHONE)
    expect(sent[0]?.segments).toBe(1)
    // 07:00 UTC is 10:00 in Athens (EEST); Greek in GSM-7 capitals; the link byte-for-byte.
    expect(sent[0]?.text).toContain('TPI 06/10 10:00')
    expect(sent[0]?.text).toContain('NIKOΣ')
    expect(sent[0]?.text).toContain(`localhost:5173/m/${TOKEN}`)
    expect(db.records()).toEqual([
      {
        p_id: MESSAGE_ID,
        p_lease_id: LEASE_ID,
        p_outcome: 'sent',
        p_provider: 'fake',
        p_provider_message_id: 'fake-1',
        p_segments: 1,
        p_cost_cents: 0,
        p_error: null,
      },
    ])
  })

  it('uses the time zone of the row, never a fixed one', async () => {
    const db = fakeRpc([row({ timezone: 'America/New_York', locale: 'en' })])
    const { provider, sent } = fakeProvider()
    await sendMessages({ rpc: db.rpc, provider, config: CONFIG, ids: [MESSAGE_ID], log: () => {} })
    expect(sent[0]?.text).toContain('Tue 06/10 03:00')
  })

  it('puts the in-memory OTP code and the WebOTP domain into the OTP SMS', async () => {
    const otpRow = row({ template: 'otp', starts_at: null, staff_name: null, manage_token: null })
    const db = fakeRpc([otpRow])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages({
      rpc: db.rpc,
      provider,
      config: CONFIG,
      ids: [MESSAGE_ID],
      extraVars: { [MESSAGE_ID]: { code: '424242' } },
      log: () => {},
    })
    expect(outcomes[MESSAGE_ID]).toBe('sent')
    expect(sent[0]?.text.startsWith('424242 ')).toBe(true)
    expect(sent[0]?.text.endsWith('@localhost #424242')).toBe(true)
  })

  it('links a cancellation to the short booking link /r/<code>', async () => {
    const db = fakeRpc([row({ template: 'cancelled_by_client', manage_token: null })])
    const { provider, sent } = fakeProvider()
    await sendMessages({ rpc: db.rpc, provider, config: CONFIG, ids: [MESSAGE_ID], log: () => {} })
    expect(sent[0]?.text).toContain('localhost:5173/r/demo01')
    expect(sent[0]?.text).not.toContain('/m/')
  })

  it('rejects a recipient outside SMS_ALLOWED_RECIPIENTS without calling the adapter', async () => {
    const db = fakeRpc([row()])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages({
      rpc: db.rpc,
      provider,
      config: { ...CONFIG, allowedRecipients: new Set(['+306912345678']) },
      ids: [MESSAGE_ID],
      log: () => {},
    })
    expect(outcomes[MESSAGE_ID]).toBe('rejected')
    expect(sent).toEqual([])
    expect(db.records()[0]).toMatchObject({
      p_outcome: 'rejected',
      p_provider: null,
      p_error: 'recipient_not_allowed',
    })
  })

  it('sends to a listed recipient', async () => {
    const db = fakeRpc([row()])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages({
      rpc: db.rpc,
      provider,
      config: { ...CONFIG, allowedRecipients: new Set([PHONE]) },
      ids: [MESSAGE_ID],
      log: () => {},
    })
    expect(outcomes[MESSAGE_ID]).toBe('sent')
    expect(sent).toHaveLength(1)
  })

  it('answers not_claimed for ids the claim did not return, and never sends them', async () => {
    const db = fakeRpc([row()])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages({
      rpc: db.rpc,
      provider,
      config: CONFIG,
      ids: [MESSAGE_ID, OTHER_ID],
      log: () => {},
    })
    expect(outcomes).toEqual({ [MESSAGE_ID]: 'sent', [OTHER_ID]: 'not_claimed' })
    expect(sent).toHaveLength(1)
  })

  it('treats a failed or empty claim as not_claimed (SMS off, cap reached, already taken)', async () => {
    for (const claimed of [
      { data: null, error: { code: '55000', message: 'vault secret otp_hmac_key is missing' } },
      ok([]),
      ok(null),
    ]) {
      const db = fakeRpc(claimed)
      const { provider, sent } = fakeProvider()
      const outcomes = await sendMessages({
        rpc: db.rpc,
        provider,
        config: CONFIG,
        ids: [MESSAGE_ID],
        log: () => {},
      })
      expect(outcomes).toEqual({ [MESSAGE_ID]: 'not_claimed' })
      expect(sent).toEqual([])
      expect(db.records()).toEqual([])
    }
  })

  it('does nothing for no ids', async () => {
    const db = fakeRpc([])
    const { provider } = fakeProvider()
    expect(
      await sendMessages({ rpc: db.rpc, provider, config: CONFIG, ids: [], log: () => {} }),
    ).toEqual({})
    expect(db.calls).toEqual([])
  })

  it('records the provider error code when the adapter refuses', async () => {
    const db = fakeRpc([row()])
    const { provider } = fakeProvider({ ok: false, error: 'invalid number: +306900000001' })
    const outcomes = await sendMessages({
      rpc: db.rpc,
      provider,
      config: CONFIG,
      ids: [MESSAGE_ID],
      log: () => {},
    })
    expect(outcomes[MESSAGE_ID]).toBe('failed')
    const recorded = db.records()[0]
    expect(recorded).toMatchObject({ p_outcome: 'failed', p_provider: 'fake' })
    // Free text may carry the number: only something shaped like a code is kept.
    expect(recorded?.p_error).toBe('provider_error')

    const coded = fakeRpc([row()])
    const refused = fakeProvider({ ok: false, error: 'rate_limited' })
    await sendMessages({
      rpc: coded.rpc,
      provider: refused.provider,
      config: CONFIG,
      ids: [MESSAGE_ID],
      log: () => {},
    })
    expect(coded.records()[0]?.p_error).toBe('rate_limited')
  })

  it('records provider_exception when the adapter throws', async () => {
    const db = fakeRpc([row()])
    const { provider } = fakeProvider(new Error('socket hang up'))
    const outcomes = await sendMessages({
      rpc: db.rpc,
      provider,
      config: CONFIG,
      ids: [MESSAGE_ID],
      log: () => {},
    })
    expect(outcomes[MESSAGE_ID]).toBe('failed')
    expect(db.records()[0]).toMatchObject({ p_outcome: 'failed', p_error: 'provider_exception' })
  })

  it('records render_error (and sends nothing) when a row lacks what its template needs', async () => {
    for (const bad of [
      row({ manage_token: null }),
      row({ template: 'cancelled_by_client', short_code: 'NOTOK!' }),
      row({ template: 'otp', starts_at: null, staff_name: null, manage_token: null }), // no code
      row({ timezone: 'Not/AZone' }),
    ]) {
      const db = fakeRpc([bad])
      const { provider, sent } = fakeProvider()
      const outcomes = await sendMessages({
        rpc: db.rpc,
        provider,
        config: CONFIG,
        ids: [MESSAGE_ID],
        log: () => {},
      })
      expect(outcomes[MESSAGE_ID]).toBe('failed')
      expect(sent).toEqual([])
      expect(db.records()[0]).toMatchObject({ p_outcome: 'failed', p_error: 'render_error' })
    }
  })

  it('releases the lease of a malformed claimed row as failed', async () => {
    const db = fakeRpc([{ id: MESSAGE_ID, lease_id: LEASE_ID, template: 'unknown_template' }])
    const { provider, sent } = fakeProvider()
    const outcomes = await sendMessages({
      rpc: db.rpc,
      provider,
      config: CONFIG,
      ids: [MESSAGE_ID],
      log: () => {},
    })
    expect(outcomes[MESSAGE_ID]).toBe('failed')
    expect(sent).toEqual([])
    expect(db.records()[0]).toMatchObject({ p_outcome: 'failed', p_error: 'invalid_claim' })
  })

  it('keeps the outcome when recording fails (the 1.5a sweep settles the row)', async () => {
    const db = fakeRpc([row()], { data: null, error: { code: '40001', message: 'x' } })
    const { provider } = fakeProvider()
    const { log, lines } = recordingLog()
    const outcomes = await sendMessages({
      rpc: db.rpc,
      provider,
      config: CONFIG,
      ids: [MESSAGE_ID],
      log,
    })
    expect(outcomes[MESSAGE_ID]).toBe('sent')
    expect(lines.map((line) => line.event)).toContain('sms_record_failed')
  })

  it('bounds what it records to the CHECKs of messages_log', async () => {
    const db = fakeRpc([row()])
    const { provider } = fakeProvider({
      ok: true,
      providerMessageId: 'x'.repeat(500),
      segments: 42,
      costCents: 3.6,
    })
    await sendMessages({ rpc: db.rpc, provider, config: CONFIG, ids: [MESSAGE_ID], log: () => {} })
    const recorded = db.records()[0]
    expect(String(recorded?.p_provider_message_id)).toHaveLength(120)
    expect(recorded?.p_segments).toBe(10)
    expect(recorded?.p_cost_cents).toBe(4)
  })

  it('never logs a phone number, a code, a token or a text', async () => {
    const otpRow = row({ template: 'otp', starts_at: null, staff_name: null, manage_token: null })
    const db = fakeRpc([row({ id: OTHER_ID }), otpRow])
    const { provider } = fakeProvider()
    const { log, lines } = recordingLog()
    await sendMessages({
      rpc: db.rpc,
      provider,
      config: CONFIG,
      ids: [MESSAGE_ID, OTHER_ID],
      extraVars: { [MESSAGE_ID]: { code: '424242' } },
      log,
    })
    const logged = JSON.stringify(lines)
    for (const secret of [PHONE, '424242', TOKEN, 'Νίκος', 'NIKOΣ', 'demo01']) {
      expect(logged).not.toContain(secret)
    }
    expect(lines.filter((line) => line.event === 'sms_send')).toHaveLength(2)
  })
})

describe('SMS variables of send.ts', () => {
  it('formats every weekday within the 9-septet date budget, in both languages', () => {
    for (let day = 0; day < 7; day++) {
      const instant = new Date(Date.UTC(2026, 11, 27 + day, 21, 30))
      for (const locale of ['el', 'en'] as const) {
        const date = formatInZone(instant, 'Europe/Athens', SMS_DATE_PATTERN, locale)
        expect(gsm7Septets(toGsm7Text(date)), date).toBeLessThanOrEqual(SMS_VARIABLE_LIMITS.date)
      }
    }
  })

  it('builds links without a scheme that fit the 40-septet budget with the longest SITE_HOST', () => {
    const longestHost = 'abcdefghij.k.gr' // 15 = MAX_SITE_HOST_LENGTH
    expect(manageLink(longestHost, TOKEN)).toHaveLength(SMS_VARIABLE_LIMITS.link)
    expect(manageLink('localhost:5173', TOKEN)).toBe(`localhost:5173/m/${TOKEN}`)
    expect(shortLink('dev.anaklo.gr', 'demo01')).toBe('dev.anaklo.gr/r/demo01')
    const vars = messageVariables(row(), { siteHost: longestHost, smsDomain: 'abcdefghij.k.gr' })
    expect(vars.link).toBe(`${longestHost}/m/${TOKEN}`)
  })
})
