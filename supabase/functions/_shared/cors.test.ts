// @vitest-environment node
import { corsHeaders as supabaseCorsHeaders } from '@supabase/supabase-js/cors'
import { describe, expect, it } from 'vitest'
import { corsPreflight, JWT_FUNCTION_CORS_HEADERS, withCors } from './cors.ts'
import { errorResponse } from './http.ts'

function headerList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0)
}

describe('cors', () => {
  it('allows every header the installed supabase-js sends, so a new one cannot break preflight', () => {
    const ours = headerList(JWT_FUNCTION_CORS_HEADERS['Access-Control-Allow-Headers'])
    const theirs = supabaseCorsHeaders['Access-Control-Allow-Headers']
    expect(theirs).toBeDefined()
    for (const name of headerList(theirs ?? '')) {
      expect(ours).toContain(name)
    }
  })

  it('answers a preflight with 204 and the allowed headers', () => {
    const response = corsPreflight()
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('authorization')
  })

  it('keeps status, body and no-store when adding the headers', async () => {
    const response = withCors(errorResponse('forbidden', 'Forbidden.', 403))
    expect(response.status).toBe(403)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await response.json()).toEqual({ error: { code: 'forbidden', message: 'Forbidden.' } })
  })
})
