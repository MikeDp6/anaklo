import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcFailure } from '@/shared/lib/rpcError'
import { DELETE_CHUNK, deleteExceptions, reassignAppointment, saveTimeOff } from './api'

/**
 * The settings writes as they reach PostgREST (review fixes of 1.6): a fake supabase-js client
 * records every chained call of every request and answers from `answerFor`. Synthetic ids only.
 */
interface Request {
  readonly target: string
  readonly steps: [string, unknown[]][]
}
interface Answer {
  readonly data: unknown
  readonly error: unknown
  readonly status: number
}

const fake = vi.hoisted(() => {
  const requests: Request[] = []
  const state = {
    answerFor: (_request: Request, _index: number): Answer => ({
      data: null,
      error: null,
      status: 204,
    }),
  }
  function builder(target: string, first?: [string, unknown[]]): unknown {
    const request: Request = { target, steps: first ? [first] : [] }
    const index = requests.length
    requests.push(request)
    const chain: object = new Proxy(
      {},
      {
        get(_, property) {
          if (property === 'then') {
            return (resolve: (answer: Answer) => unknown, reject: (reason: unknown) => unknown) =>
              Promise.resolve(state.answerFor(request, index)).then(resolve, reject)
          }
          return (...args: unknown[]) => {
            request.steps.push([String(property), args])
            return chain
          }
        },
      },
    )
    return chain
  }
  const supabase = {
    from: (table: string) => builder(`from:${table}`),
    rpc: (name: string, args: unknown) => builder(`rpc:${name}`, ['args', [args]]),
  }
  return { requests, state, supabase }
})
vi.mock('@/shared/lib/supabase', () => ({ supabase: fake.supabase }))

const BUSINESS = '00000000-0000-4000-8000-000000000001'
const STAFF = '00000000-0000-4000-8000-000000000102'
const ROW = '00000000-0000-4000-8000-00000000f001'

function idsOf(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  )
}

function step(request: Request | undefined, name: string): unknown[][] {
  return (request?.steps ?? []).filter(([method]) => method === name).map(([, args]) => args)
}

afterEach(() => {
  fake.requests.length = 0
  fake.state.answerFor = () => ({ data: null, error: null, status: 204 })
})

describe('deleteExceptions: a large grouped item (62 dates × 4 intervals)', () => {
  it('goes out in requests of at most 100 ids (from ~240 uuids the URL is too long: 414)', async () => {
    const ids = idsOf(62 * 4)
    await deleteExceptions(BUSINESS, ids)

    expect(DELETE_CHUNK).toBeLessThanOrEqual(100)
    expect(fake.requests.map((request) => request.target)).toEqual([
      'from:schedule_exceptions',
      'from:schedule_exceptions',
      'from:schedule_exceptions',
    ])
    const sent = fake.requests.map((request) => step(request, 'in')[0])
    expect(sent.map((args) => (args?.[1] as string[]).length)).toEqual([100, 100, 48])
    expect(sent.flatMap((args) => args?.[1] as string[])).toEqual(ids)
    for (const request of fake.requests) {
      expect(step(request, 'delete')).toHaveLength(1)
      expect(step(request, 'eq')).toEqual([['business_id', BUSINESS]])
    }
  })

  it('stops at the first refused request and reports it', async () => {
    fake.state.answerFor = (_, index) =>
      index === 1
        ? { data: null, error: { code: '42501', message: 'denied' }, status: 403 }
        : { data: null, error: null, status: 204 }
    await expect(deleteExceptions(BUSINESS, idsOf(248))).rejects.toMatchObject({
      failure: { kind: 'forbidden' },
    })
    expect(fake.requests).toHaveLength(2)
  })

  it('a small item is still one request', async () => {
    await deleteExceptions(BUSINESS, idsOf(2))
    expect(fake.requests).toHaveLength(1)
  })
})

describe('saveTimeOff of an existing row', () => {
  const input = {
    id: ROW,
    staffId: STAFF,
    reason: 'vacation' as const,
    startsAt: '2026-10-05T21:00:00.000Z',
    endsAt: '2026-10-09T21:00:00.000Z',
    isNew: false,
  }

  it('updates range and reason of that staff member’s row and asks for it back', async () => {
    fake.state.answerFor = () => ({ data: [{ id: ROW }], error: null, status: 200 })
    await expect(saveTimeOff(BUSINESS, input)).resolves.toBeUndefined()
    const [request] = fake.requests
    expect(step(request, 'update')).toEqual([
      [{ starts_at: input.startsAt, ends_at: input.endsAt, reason: 'vacation' }],
    ])
    expect(step(request, 'eq')).toEqual([
      ['business_id', BUSINESS],
      ['id', ROW],
      ['staff_id', STAFF],
    ])
    expect(step(request, 'select')).toEqual([['id']])
  })

  it('no row updated (deleted elsewhere meanwhile) is `gone`, never a success', async () => {
    fake.state.answerFor = () => ({ data: [], error: null, status: 200 })
    const failure = await saveTimeOff(BUSINESS, input).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RpcFailure)
    expect(failure).toMatchObject({ failure: { kind: 'gone' } })
  })
})

describe('reassignAppointment', () => {
  it('sends the row as it was seen with the colleague (reassign_appointment)', async () => {
    fake.state.answerFor = () => ({
      data: {
        appointment_id: ROW,
        staff_id: STAFF,
        starts_at: '2026-10-02T09:00:00+00:00',
        ends_at: '2026-10-02T09:30:00+00:00',
        warnings: [],
        from_staff_id: '00000000-0000-4000-8000-000000000101',
        from_starts_at: '2026-10-02T09:00:00+00:00',
        replayed: false,
        notify: false,
        sms_queued: false,
      },
      error: null,
      status: 200,
    })
    const result = await reassignAppointment(BUSINESS, {
      appointmentId: ROW,
      idempotencyKey: '4f1c1e9a-7d0e-4c1b-9a51-2f3e8d7c6b5a',
      expectedStaffId: '00000000-0000-4000-8000-000000000101',
      expectedStartsAt: '2026-10-02T09:00:00+00:00',
      newStaffId: STAFF,
      notify: false,
    })
    const [request] = fake.requests
    expect(request?.target).toBe('rpc:reassign_appointment')
    expect(step(request, 'args')).toEqual([
      [
        {
          p_business_id: BUSINESS,
          p_appointment_id: ROW,
          p_idempotency_key: '4f1c1e9a-7d0e-4c1b-9a51-2f3e8d7c6b5a',
          p_expected_staff_id: '00000000-0000-4000-8000-000000000101',
          p_expected_starts_at: '2026-10-02T09:00:00+00:00',
          p_new_staff_id: STAFF,
          p_notify: false,
        },
      ],
    ])
    expect(result).toMatchObject({ staffId: STAFF, fromStartsAt: '2026-10-02T09:00:00+00:00' })
  })
})
