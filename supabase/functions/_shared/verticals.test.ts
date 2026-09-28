import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import { Vertical } from './domain.ts'

/**
 * packages/verticals/<vertical>.json (the vertical templates) and private.vertical_defaults
 * (0005, read by private.next_visit_hint_impl) hold the same defaults: one row per JSON file,
 * with the same values, and no row without a file.
 */
const ROOT = process.cwd()
const VERTICALS_DIR = join(ROOT, 'packages', 'verticals')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')

/** Same bounds as the CHECKs of private.vertical_defaults. */
const VerticalDefaults = z.object({
  vertical: Vertical,
  rebook_interval_days: z.int().check(z.gte(7), z.lte(365)),
})

function jsonFiles(): string[] {
  return readdirSync(VERTICALS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
}

function jsonDefaults(): Record<string, number> {
  const entries = jsonFiles().map((file): [string, number] => {
    const parsed = VerticalDefaults.parse(
      JSON.parse(readFileSync(join(VERTICALS_DIR, file), 'utf8')),
    )
    return [parsed.vertical, parsed.rebook_interval_days]
  })
  return Object.fromEntries(entries)
}

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    .join('\n')
}

/**
 * vertical → rebook_interval_days after replaying, in migration order, every
 * `insert into private.vertical_defaults (vertical, rebook_interval_days) values (…), …;`,
 * `update private.vertical_defaults set rebook_interval_days = N where vertical = '…';` and
 * `delete from private.vertical_defaults where vertical = '…';`. Any other statement form on the
 * table fails the test, so a future migration cannot slip past it.
 */
function sqlDefaults(sql: string): Record<string, number> {
  const rows = new Map<string, number>()
  const statements = sql.matchAll(
    /\b(insert\s+into|update|delete\s+from)\s+private\.vertical_defaults\b([\s\S]*?);/gi,
  )
  for (const [statement, verb = '', rest = ''] of statements) {
    const kind = verb.toLowerCase().split(/\s+/)[0]
    if (kind === 'insert') {
      const shape = /^\s*\(\s*vertical\s*,\s*rebook_interval_days\s*\)\s*values\s*([\s\S]*)$/i.exec(
        rest,
      )
      if (!shape?.[1] || /on\s+conflict/i.test(shape[1]))
        throw new Error(`unsupported: ${statement}`)
      for (const [, vertical = '', days = ''] of shape[1].matchAll(
        /\(\s*'([a-z_]+)'\s*,\s*(\d+)\s*\)/g,
      ))
        rows.set(vertical, Number(days))
    } else if (kind === 'update') {
      const shape =
        /^\s*set\s+rebook_interval_days\s*=\s*(\d+)\s+where\s+vertical\s*=\s*'([a-z_]+)'\s*$/i.exec(
          rest,
        )
      if (!shape?.[1] || !shape[2]) throw new Error(`unsupported: ${statement}`)
      rows.set(shape[2], Number(shape[1]))
    } else {
      const shape = /^\s*where\s+vertical\s*=\s*'([a-z_]+)'\s*$/i.exec(rest)
      if (!shape?.[1]) throw new Error(`unsupported: ${statement}`)
      rows.delete(shape[1])
    }
  }
  return Object.fromEntries(rows)
}

describe('packages/verticals = private.vertical_defaults', () => {
  it('has one file per vertical, named after it', () => {
    const files = jsonFiles()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const parsed = VerticalDefaults.parse(
        JSON.parse(readFileSync(join(VERTICALS_DIR, file), 'utf8')),
      )
      expect(file).toBe(`${parsed.vertical}.json`)
    }
  })

  it('every JSON file has a row with the same values, and every row has a file', () => {
    expect(sqlDefaults(migrationSql())).toEqual(jsonDefaults())
  })

  it('reads inserts, updates and deletes in migration order', () => {
    const sql = `
      insert into private.vertical_defaults (vertical, rebook_interval_days) values ('barber', 28), ('beauty', 42);
      update private.vertical_defaults set rebook_interval_days = 21 where vertical = 'barber';
      delete from private.vertical_defaults where vertical = 'beauty';`
    expect(sqlDefaults(sql)).toEqual({ barber: 21 })
    expect(() =>
      sqlDefaults(`insert into private.vertical_defaults values ('barber', 28);`),
    ).toThrow(/unsupported/)
  })
})
