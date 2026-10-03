import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECKED_VALUE_LISTS,
  CLIENT_CARD_STATES,
  CONFLICT_REASONS,
  CONSENT_STATES,
  HEALTH_CHECK_NAMES,
  JOB_NAMES,
  MESSAGE_TEMPLATES,
  PUSH_MESSAGE_TEMPLATES,
  REASSIGN_BLOCKERS,
  RING_STATES,
  SECURITY_EMAIL_AUDIENCES,
  SMS_MESSAGE_TEMPLATES,
  STEP_UP_HINTS,
  SUPPORT_ACTIONS,
} from './domain.ts'
import { PUSH_TEMPLATES } from './push-templates.ts'
import { SMS_TEMPLATES } from './sms-templates.ts'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    .join('\n')
}

/**
 * Values of the LATEST `constraint <name> check (<column> in ('a', 'b', …))` across all
 * migrations (expand/contract migrations redefine constraints), or null if it was never defined
 * or was dropped afterwards without being re-added.
 */
function checkValues(sql: string, constraint: string): string[] | null {
  const definition = new RegExp(
    `constraint\\s+${constraint}\\s+check\\s*\\(\\s*\\w+\\s+in\\s*\\(([^)]*)\\)`,
    'gi',
  )
  const matches = [...sql.matchAll(definition)]
  const last = matches.at(-1)
  if (!last?.[1]) return null
  const dropped = new RegExp(`drop\\s+constraint\\s+(if\\s+exists\\s+)?${constraint}\\b`, 'gi')
  const lastDrop = [...sql.matchAll(dropped)].at(-1)
  if (lastDrop && lastDrop.index > last.index) return null
  return [...last[1].matchAll(/'([^']*)'/g)].map((value) => value[1] ?? '')
}

describe('value lists match the database CHECK constraints', () => {
  const sql = migrationSql()

  it.each(Object.entries(CHECKED_VALUE_LISTS))('%s', (constraint, values) => {
    const inDatabase = checkValues(sql, constraint)
    expect(inDatabase, `constraint ${constraint} not found in migrations`).not.toBeNull()
    expect([...(inDatabase ?? [])].sort()).toEqual([...values].sort())
  })
})

describe('message templates', () => {
  it('every SMS template has an SMS text, and every SMS text is a template', () => {
    expect(Object.keys(SMS_TEMPLATES).sort()).toEqual([...SMS_MESSAGE_TEMPLATES].sort())
  })

  it('every push template has a push text, and every push text is a template', () => {
    expect(Object.keys(PUSH_TEMPLATES).sort()).toEqual([...PUSH_MESSAGE_TEMPLATES].sort())
  })

  it('messages_log templates are exactly the SMS templates and the push templates', () => {
    expect([...MESSAGE_TEMPLATES].sort()).toEqual(
      [...SMS_MESSAGE_TEMPLATES, ...PUSH_MESSAGE_TEMPLATES].sort(),
    )
    expect(new Set(MESSAGE_TEMPLATES).size).toBe(MESSAGE_TEMPLATES.length)
    expect(PUSH_MESSAGE_TEMPLATES.every((key) => key.startsWith('push_'))).toBe(true)
    expect(SMS_MESSAGE_TEMPLATES.some((key) => key.startsWith('push_'))).toBe(false)
  })
})

/** The body of `create function <name>(` … `$$;` in the given SQL, or null. */
function functionBody(sql: string, name: string): string | null {
  const start = sql.indexOf(`create function ${name}(`)
  if (start < 0) return null
  const open = sql.indexOf('$$', start)
  const close = sql.indexOf('$$;', open + 2)
  return open < 0 || close < 0 ? null : sql.slice(open, close)
}

describe('RPC output lists match the functions that produce them (0008)', () => {
  const sql = migrationSql()

  it.each([
    ['private.schedule_conflicts_core', CONFLICT_REASONS],
    ['private.reassign_candidates_impl', REASSIGN_BLOCKERS],
  ] as const)('%s names every value, in the order of the list', (name, values) => {
    const body = functionBody(sql, name)
    expect(body, `function ${name} not found in migrations`).not.toBeNull()
    const positions = values.map((value) => body?.indexOf(`'${value}'`) ?? -1)
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})

describe('RPC inputs and hints match the functions that use them (0009)', () => {
  const sql = migrationSql()

  it('private.require_fresh_totp raises exactly the step-up hints', () => {
    const body = functionBody(sql, 'private.require_fresh_totp')
    expect(body, 'function private.require_fresh_totp not found in migrations').not.toBeNull()
    const hints = [...(body ?? '').matchAll(/hint\s*=\s*'([a-z_0-9]+)'/g)].map((m) => m[1])
    expect(hints).toEqual([...STEP_UP_HINTS])
  })

  it('private.record_support_action_impl accepts exactly the support actions', () => {
    const body = functionBody(sql, 'private.record_support_action_impl')
    expect(
      body,
      'function private.record_support_action_impl not found in migrations',
    ).not.toBeNull()
    const accepted = /p_action\s+not\s+in\s*\(([^)]*)\)/.exec(body ?? '')?.[1] ?? ''
    const values = [...accepted.matchAll(/'([^']*)'/g)].map((m) => m[1])
    expect(values).toEqual([...SUPPORT_ACTIONS])
  })
})

describe('RPC output lists match the functions that produce them (0010)', () => {
  const sql = migrationSql()

  it.each([
    ['private.client_card_impl', CLIENT_CARD_STATES],
    ['private.client_card_impl', RING_STATES],
    ['private.consent_state', CONSENT_STATES],
  ] as const)('%s names every value of %j', (name, values) => {
    const body = functionBody(sql, name)
    expect(body, `function ${name} not found in migrations`).not.toBeNull()
    for (const value of values) {
      expect(body?.includes(`'${value}'`), `${name} names '${value}'`).toBe(true)
    }
  })
})

describe('RPC output lists match the functions that produce them (0011)', () => {
  const sql = migrationSql()

  it('health checks are exactly the watched jobs and the security events', () => {
    expect([...HEALTH_CHECK_NAMES]).toEqual([...JOB_NAMES, 'security_events'])
    expect(new Set(HEALTH_CHECK_NAMES).size).toBe(HEALTH_CHECK_NAMES.length)
  })

  it('0011 watches every job: one health_jobs row per job name', () => {
    const insert = /insert\s+into\s+private\.health_jobs\s*\([^)]*\)\s*values([^;]*);/i.exec(sql)
    expect(insert, 'insert into private.health_jobs not found in migrations').not.toBeNull()
    const jobs = [...(insert?.[1] ?? '').matchAll(/\(\s*'([a-z_]+)'\s*,/g)].map((m) => m[1])
    expect([...jobs].sort()).toEqual([...JOB_NAMES].sort())
  })

  it('private.health_impl names the security events check', () => {
    const body = functionBody(sql, 'private.health_impl')
    expect(body, 'function private.health_impl not found in migrations').not.toBeNull()
    expect(body?.includes(`'security_events'`)).toBe(true)
  })

  it('private.queue_security_notifications names every email audience, in the order of the list', () => {
    const body = functionBody(sql, 'private.queue_security_notifications')
    expect(
      body,
      'function private.queue_security_notifications not found in migrations',
    ).not.toBeNull()
    const positions = SECURITY_EMAIL_AUDIENCES.map(
      (value) => body?.indexOf(`'audience', '${value}'`) ?? -1,
    )
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})
