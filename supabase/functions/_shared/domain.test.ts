import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECKED_VALUE_LISTS } from './domain.ts'

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
