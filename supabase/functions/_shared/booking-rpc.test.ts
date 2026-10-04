// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { callRpc, DOMAIN_ERROR_HTTP_STATUS, domainErrorResponse, type Log } from './booking-rpc.ts'
import { DOMAIN_ERROR_CODES, DOMAIN_ERRORS } from './errors.ts'

const silent: Log = () => {}

describe('DOMAIN_ERROR_HTTP_STATUS', () => {
  it('has a status for exactly the domain error codes', () => {
    expect(Object.keys(DOMAIN_ERROR_HTTP_STATUS).sort()).toEqual([...DOMAIN_ERROR_CODES].sort())
  })

  it('uses the statuses of contract 1.3 §2.1 (1.7 §2.9 for AN024–AN031, 1.8 §2.8 for AN032–AN033, 1.9b G2 for AN034)', () => {
    const byStatus: Record<number, string[]> = {}
    for (const [code, status] of Object.entries(DOMAIN_ERROR_HTTP_STATUS)) {
      ;(byStatus[status] ??= []).push(code)
    }
    expect(byStatus).toEqual({
      403: ['AN014', 'AN015', 'AN027', 'AN034'],
      404: ['AN009', 'AN030'],
      409: [
        'AN001',
        'AN004',
        'AN021',
        'AN024',
        'AN025',
        'AN026',
        'AN028',
        'AN029',
        'AN031',
        'AN032',
        'AN033',
      ],
      422: [
        'AN002',
        'AN003',
        'AN005',
        'AN006',
        'AN007',
        'AN008',
        'AN010',
        'AN011',
        'AN012',
        'AN016',
        'AN018',
        'AN020',
        'AN022',
        'AN023',
      ],
      429: ['AN013', 'AN019'],
      503: ['AN017'],
    })
  })

  it('answers { error: { code, message: name } }', async () => {
    const response = domainErrorResponse('AN019')
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: { code: 'AN019', message: DOMAIN_ERRORS.AN019 },
    })
  })
})

describe('callRpc', () => {
  it('passes data through', async () => {
    const outcome = await callRpc(
      (fn, args) => Promise.resolve({ data: { fn, args }, error: null }),
      silent,
      'manage_view',
      { p_token: 'x' },
    )
    expect(outcome).toEqual({ ok: true, data: { fn: 'manage_view', args: { p_token: 'x' } } })
  })

  it('turns a raised domain error into its HTTP answer', async () => {
    const outcome = await callRpc(
      () => Promise.resolve({ data: null, error: { code: 'P0001', message: 'AN001' } }),
      silent,
      'book_appointment',
      {},
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('AN001')
    expect(outcome.response.status).toBe(409)
  })

  it('answers 500 internal for anything else and logs only the SQLSTATE', async () => {
    const lines: unknown[] = []
    const log: Log = (event, fields) => lines.push({ event, fields })
    for (const error of [
      { code: 'P0001', message: 'not a domain code +306900000001' },
      { code: '55000', message: 'vault secret otp_hmac_key is missing' },
      { code: '42501', message: 'permission denied' },
    ]) {
      const outcome = await callRpc(
        () => Promise.resolve({ data: null, error }),
        log,
        'otp_start',
        {},
      )
      expect(outcome.ok ? 200 : outcome.response.status).toBe(500)
    }
    const thrown = await callRpc(
      () => Promise.reject(new Error('fetch failed')),
      log,
      'otp_start',
      {},
    )
    expect(thrown.ok ? 200 : thrown.response.status).toBe(500)
    expect(JSON.stringify(lines)).not.toContain('+306900000001')
    expect(JSON.stringify(lines)).toContain('55000')
  })
})
