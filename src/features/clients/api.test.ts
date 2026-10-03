import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addClientNote,
  deleteClientNote,
  eraseClient,
  setClientConsent,
  updateClientDetails,
} from './api'
import { STAFF_CONSENT_NOTICE_VERSION } from './schema'
import { CLIENT_IDS } from './testFixtures'

/**
 * The client writes as they reach PostgREST (contract 1.8 §3.1): a fake supabase-js client
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
    answerFor: (_request: Request): Answer => ({ data: null, error: null, status: 204 }),
  }
  function builder(target: string, first?: [string, unknown[]]): unknown {
    const request: Request = { target, steps: first ? [first] : [] }
    requests.push(request)
    const chain: object = new Proxy(
      {},
      {
        get(_, property) {
          if (property === 'then') {
            return (resolve: (answer: Answer) => unknown, reject: (reason: unknown) => unknown) =>
              Promise.resolve(state.answerFor(request)).then(resolve, reject)
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

const B = CLIENT_IDS.business
const C = CLIENT_IDS.client

function steps(name: string): unknown[][] {
  return (fake.requests[0]?.steps ?? []).filter(([method]) => method === name).map(([, a]) => a)
}

afterEach(() => {
  fake.requests.length = 0
  fake.state.answerFor = () => ({ data: null, error: null, status: 204 })
})

const CONSENT_ANSWER = {
  client_id: C,
  purpose: 'marketing_sms',
  state: 'granted',
  changed: true,
  consent_id: CLIENT_IDS.grant,
  withdrawn: 0,
}

describe('setClientConsent (contract 1.8 D8)', () => {
  it('a grant carries who gave it and the version of the confirmed text', async () => {
    fake.state.answerFor = () => ({ data: CONSENT_ANSWER, error: null, status: 200 })
    await setClientConsent(B, {
      clientId: C,
      purpose: 'marketing_sms',
      granted: true,
      givenBy: 'guardian',
    })
    expect(fake.requests[0]?.target).toBe('rpc:set_client_consent')
    expect(steps('args')).toEqual([
      [
        {
          p_business_id: B,
          p_client_id: C,
          p_purpose: 'marketing_sms',
          p_granted: true,
          p_given_by: 'guardian',
          p_policy_version: STAFF_CONSENT_NOTICE_VERSION,
        },
      ],
    ])
    expect(steps('abortSignal')).toHaveLength(1)
  })

  it('a withdrawal sends only the purpose and false', async () => {
    fake.state.answerFor = () => ({
      data: { ...CONSENT_ANSWER, state: 'none', consent_id: null, withdrawn: 1 },
      error: null,
      status: 200,
    })
    const result = await setClientConsent(B, {
      clientId: C,
      purpose: 'marketing_sms',
      granted: false,
      givenBy: null,
    })
    expect(steps('args')).toEqual([
      [{ p_business_id: B, p_client_id: C, p_purpose: 'marketing_sms', p_granted: false }],
    ])
    expect(result).toMatchObject({ state: 'none', withdrawn: 1 })
  })
})

describe('notes', () => {
  it('a note is an upsert of its own id that ignores a duplicate (the retry of a saved note)', async () => {
    await addClientNote(B, {
      id: CLIENT_IDS.note,
      clientId: C,
      authorId: CLIENT_IDS.owner,
      body: 'Κοντά στο πλάι',
    })
    expect(fake.requests[0]?.target).toBe('from:client_notes')
    expect(steps('upsert')).toEqual([
      [
        {
          id: CLIENT_IDS.note,
          business_id: B,
          client_id: C,
          author_id: CLIENT_IDS.owner,
          body: 'Κοντά στο πλάι',
        },
        { onConflict: 'id', ignoreDuplicates: true },
      ],
    ])
  })

  it('a delete that found nothing is 0, not an error', async () => {
    fake.state.answerFor = () => ({ data: [], error: null, status: 200 })
    expect(await deleteClientNote(B, CLIENT_IDS.note)).toBe(0)
    expect(steps('eq')).toEqual([
      ['business_id', B],
      ['id', CLIENT_IDS.note],
    ])
  })
})

describe('updateClientDetails', () => {
  it('writes name, mobile and language only; no row back is `gone`', async () => {
    fake.state.answerFor = () => ({ data: [], error: null, status: 200 })
    await expect(
      updateClientDetails(B, C, { fullName: 'Γιώργος Π.', phoneE164: null, locale: 'en' }),
    ).rejects.toMatchObject({ failure: { kind: 'gone' } })
    expect(steps('update')).toEqual([[{ full_name: 'Γιώργος Π.', phone_e164: null, locale: 'en' }]])
  })
})

describe('eraseClient', () => {
  it('calls erase_client; the step-up answer is classified for withStepUp', async () => {
    fake.state.answerFor = () => ({
      data: null,
      error: { code: '42501', message: 'fresh code needed', hint: 'fresh_totp_required' },
      status: 403,
    })
    await expect(eraseClient(B, C)).rejects.toMatchObject({
      failure: { kind: 'stepUp', hint: 'fresh_totp_required' },
    })
    expect(fake.requests[0]?.target).toBe('rpc:erase_client')
    expect(steps('args')).toEqual([[{ p_business_id: B, p_client_id: C }]])
  })
})
