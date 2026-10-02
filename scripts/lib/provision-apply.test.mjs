// @vitest-environment node
// provisionBusiness against an in-memory stand-in of the tables and the Auth admin API, with a
// log of every call (contract 1.7 §5.2): the alias refusal, the reason/ticket gate of a change to
// an existing business, and that its audit row comes before the first write.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './cli.mjs'
import { ProvisionConflict, formatSummary, provisionBusiness } from './provision-apply.mjs'
import { LOCAL_SUPPORT, parseProvisionArgs } from './provision-args.mjs'
import { parseProvisionFile } from './provision-schema.mjs'

const EXAMPLE = path.join(REPO_ROOT, 'supabase', 'provision', 'demo-barber.example.json')
const SUPPORT = { reason: 'new opening hours', ticket: 'T-42' }

function desiredFromExample() {
  const parsed = parseProvisionFile(JSON.parse(readFileSync(EXAMPLE, 'utf8')))
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
  return parsed.desired
}

/**
 * @typedef {{ table: string, op: string, payload?: unknown }} Call
 * @typedef {Record<string, unknown>} Row
 */

/** A minimal PostgREST/Auth stand-in: equality and `in` filters, ids from a counter. */
function fakeDb() {
  /** @type {Record<string, Row[]>} */
  const tables = {
    businesses: [],
    business_slug_aliases: [],
    service_categories: [],
    services: [],
    staff: [],
    staff_services: [],
    working_hours: [],
    business_members: [],
  }
  /** @type {Array<{ id: string, email: string }>} */
  const users = []
  /** @type {Call[]} */
  const calls = []
  let next = 0
  const newId = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`

  /** @param {string} table */
  function from(table) {
    const rows = tables[table]
    if (!rows) throw new Error(`unknown table ${table}`)
    /** @type {Array<(row: Row) => boolean>} */
    const filters = []
    /** @type {{ op: 'select' | 'insert' | 'update' | 'delete', payload?: unknown, single?: 'single' | 'maybe' }} */
    const state = { op: 'select' }
    const matches = () => rows.filter((row) => filters.every((filter) => filter(row)))

    const run = () => {
      if (state.op !== 'select') calls.push({ table, op: state.op, payload: state.payload })
      /** @type {Row[]} */
      let result = []
      if (state.op === 'select') result = matches().map((row) => ({ ...row }))
      if (state.op === 'insert') {
        const list = Array.isArray(state.payload) ? state.payload : [state.payload]
        result = list.map((row) => ({ id: newId(), ...row }))
        rows.push(...result)
      }
      if (state.op === 'update') {
        result = matches()
        for (const row of result) Object.assign(row, state.payload)
      }
      if (state.op === 'delete') {
        result = matches()
        tables[table] = rows.filter((row) => !result.includes(row))
      }
      if (state.single === 'single') return { data: result[0] ?? null, error: null }
      if (state.single === 'maybe') return { data: result[0] ?? null, error: null }
      return { data: result, error: null }
    }

    const builder = {
      /** Every column comes back: the comparisons read only the ones they need. */
      select() {
        return builder
      },
      /** @param {unknown} payload */
      insert(payload) {
        state.op = 'insert'
        state.payload = payload
        return builder
      },
      /** @param {unknown} payload */
      update(payload) {
        state.op = 'update'
        state.payload = payload
        return builder
      },
      delete() {
        state.op = 'delete'
        return builder
      },
      /** @param {string} column @param {unknown} value */
      eq(column, value) {
        filters.push((row) => row[column] === value)
        return builder
      },
      /** @param {string} column @param {readonly unknown[]} values */
      in(column, values) {
        filters.push((row) => values.includes(row[column]))
        return builder
      },
      single() {
        state.single = 'single'
        return Promise.resolve(run())
      },
      maybeSingle() {
        state.single = 'maybe'
        return Promise.resolve(run())
      },
      /**
       * @param {(value: unknown) => unknown} resolve
       * @param {(reason: unknown) => unknown} [reject]
       */
      then(resolve, reject) {
        return Promise.resolve(run()).then(resolve, reject)
      },
    }
    return builder
  }

  const db = {
    from,
    /** @param {string} fn @param {Record<string, unknown>} args */
    rpc(fn, args) {
      calls.push({ table: `rpc:${fn}`, op: 'rpc', payload: args })
      return Promise.resolve({ data: { action: args.p_action, audit_rows: 1 }, error: null })
    },
    auth: {
      admin: {
        listUsers() {
          return Promise.resolve({
            data: { users: users.map((user) => ({ ...user })) },
            error: null,
          })
        },
        /** @param {{ email: string }} attributes */
        createUser(attributes) {
          calls.push({ table: 'auth.users', op: 'createUser', payload: attributes })
          const user = { id: newId(), email: attributes.email }
          users.push(user)
          return Promise.resolve({ data: { user }, error: null })
        },
      },
    },
  }
  /** @type {import('@supabase/supabase-js').SupabaseClient<import('../../src/shared/lib/database.types.ts').Database>} */
  const client = /** @type {never} */ (/** @type {unknown} */ (db))
  return { client, tables, calls, users }
}

/** A database that already holds the example business exactly as the file describes it. */
async function provisionedDb() {
  const fake = fakeDb()
  await provisionBusiness(fake.client, desiredFromExample())
  fake.calls.length = 0
  return fake
}

describe('provisionBusiness: aliases (contract 1.7 D7)', () => {
  it('refuses a slug that is a former address of another business, before any write', async () => {
    const fake = fakeDb()
    fake.tables.business_slug_aliases?.push({
      slug: 'demo-provision',
      business_id: '00000000-0000-4000-8000-0000000000ff',
    })
    const run = provisionBusiness(fake.client, desiredFromExample(), SUPPORT)
    await expect(run).rejects.toThrow(ProvisionConflict)
    await expect(run).rejects.toThrow(/former address of another business/)
    expect(fake.calls).toEqual([])
    expect(fake.users).toEqual([])
  })
})

describe('provisionBusiness: changes to an existing business (contract 1.7 §5.2)', () => {
  it('creates a new business without a reason or a ticket, and audits nothing', async () => {
    const fake = fakeDb()
    const summary = await provisionBusiness(fake.client, desiredFromExample())
    expect(summary.business).toBe('created')
    expect(summary.audited).toBe(false)
    expect(fake.calls.some((call) => call.op === 'rpc')).toBe(false)
  })

  it('needs no support for an unchanged rerun, and writes nothing', async () => {
    const fake = await provisionedDb()
    const summary = await provisionBusiness(fake.client, desiredFromExample())
    expect(fake.calls).toEqual([])
    expect(summary.business).toBe('unchanged')
    expect(summary.audited).toBe(false)
    expect(formatSummary(summary).at(-1)).toBe('No changes.')
  })

  it('refuses a change without --reason/--ticket before any write', async () => {
    const fake = await provisionedDb()
    const desired = desiredFromExample()
    desired.business.name = 'Renamed Barber'
    const run = provisionBusiness(fake.client, desired)
    await expect(run).rejects.toThrow(ProvisionConflict)
    await expect(run).rejects.toThrow(/--reason .* --ticket/)
    expect(fake.calls).toEqual([])
    expect(fake.tables.businesses?.[0]?.name).toBe('Demo Provision Barber')
  })

  it('refuses a new login on an existing business without support, creating no user', async () => {
    const fake = await provisionedDb()
    const desired = desiredFromExample()
    desired.members.push({ email: 'new-manager@demo-provision.test', role: 'manager', staff: null })
    const usersBefore = fake.users.length
    await expect(provisionBusiness(fake.client, desired)).rejects.toThrow(ProvisionConflict)
    expect(fake.users).toHaveLength(usersBefore)
    expect(fake.calls).toEqual([])
  })

  it('writes the audit row first, once, then the changes', async () => {
    const fake = await provisionedDb()
    const desired = desiredFromExample()
    desired.business.name = 'Renamed Barber'
    desired.categories.push({ name: 'Νέα κατηγορία', sort: 9 })
    const summary = await provisionBusiness(fake.client, desired, SUPPORT)

    expect(summary.audited).toBe(true)
    expect(fake.calls[0]).toEqual({
      table: 'rpc:record_support_action',
      op: 'rpc',
      payload: {
        p_action: 'provision_update',
        p_reason: 'new opening hours',
        p_ticket: 'T-42',
        p_business_id: fake.tables.businesses?.[0]?.id,
      },
    })
    expect(fake.calls.filter((call) => call.op === 'rpc')).toHaveLength(1)
    expect(fake.calls.slice(1).map((call) => `${call.op} ${call.table}`)).toEqual([
      'update businesses',
      'insert service_categories',
    ])
    expect(formatSummary(summary)).toContain(
      '  audit_log       provision_update recorded before the changes',
    )
  })
})

describe('provision-business.mjs arguments', () => {
  it('refuses an unknown option before anything else', () => {
    expect(() => parseProvisionArgs(['--local', '--yes'])).toThrow(/Unknown option '--yes'/)
    expect(() => parseProvisionArgs(['stray'])).toThrow(/positional/i)
  })

  it('defaults reason and ticket for --local only', () => {
    expect(parseProvisionArgs(['--local']).support).toEqual(LOCAL_SUPPORT)
    expect(parseProvisionArgs([]).support).toBeUndefined()
    expect(
      parseProvisionArgs(['--file', 'x.json', '--reason', '  hours  ', '--ticket', 'NOUS-7'])
        .support,
    ).toEqual({ reason: 'hours', ticket: 'NOUS-7' })
  })

  it.each([
    [['--reason', 'new hours']],
    [['--ticket', 'T-1']],
    [['--reason', 'ok', '--ticket', 'T-1']],
    [['--reason', 'new hours', '--ticket', '-x']],
    [['--reason', 'new hours', '--ticket', 'a b']],
  ])('refuses an incomplete or malformed reason/ticket: %j', (argv) => {
    expect(() => parseProvisionArgs(argv)).toThrow(/--reason|--ticket/)
  })

  it('exits 2 on an unknown option, with --local and before any connection', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'provision-business.mjs'), '--local', '--no-such-option'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 },
    )
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("Unknown option '--no-such-option'")
    // A cold node start with supabase-js can take seconds while the whole suite runs.
  }, 30_000)
})
