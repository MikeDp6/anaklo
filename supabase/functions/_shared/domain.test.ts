import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECKED_VALUE_LISTS,
  MESSAGE_TEMPLATES,
  PUSH_MESSAGE_TEMPLATES,
  SMS_MESSAGE_TEMPLATES,
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
