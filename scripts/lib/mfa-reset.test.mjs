// @vitest-environment node
// The Nous reset (contract 1.7 §5.1) on fake ports with a call log: the dry run writes nothing,
// --yes writes the grants and audit rows BEFORE deleting, deletes every factor, then revokes
// every session; the runbook's email templates are complete and fill without leftovers.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, UsageError } from './cli.mjs'
import {
  EMAIL_TEMPLATE_IDS,
  ResetStepError,
  extractEmailTemplates,
  fillTemplate,
  formatResetDate,
  parseMfaResetArgs,
  resetFactorsWith,
  runMfaReset,
  supportPorts,
} from './mfa-reset.mjs'

/**
 * @typedef {import('./mfa-reset.mjs').MfaResetPorts} MfaResetPorts
 * @typedef {import('./mfa-reset.mjs').DeleteOutcome} DeleteOutcome
 */

const USER = '00000000-0000-4000-8000-00000000a017'
const SHOP = '00000000-0000-4000-8000-000000000001'
const OTHER_SHOP = '00000000-0000-4000-8000-000000000002'
const F1 = '00000000-0000-4000-8000-0000000f0001'
const F2 = '00000000-0000-4000-8000-0000000f0002'
const RUNBOOK = readFileSync(path.join(REPO_ROOT, 'docs', 'runbooks', 'mfa-reset.md'), 'utf8')
const TEMPLATES = extractEmailTemplates(RUNBOOK)
const NOW = new Date('2026-10-02T09:30:00Z')

/**
 * @param {{ userId?: string | null, roles?: Array<'owner' | 'manager'>, deletes?: DeleteOutcome[] }} [options]
 */
function fakePorts(options = {}) {
  /** @type {string[]} */
  const calls = []
  const deletes = [...(options.deletes ?? [])]
  const roles = options.roles ?? ['manager', 'owner']
  /** @type {MfaResetPorts} */
  const ports = {
    userIdForEmail(email) {
      calls.push(`user_id_for_email ${email}`)
      return Promise.resolve(options.userId === undefined ? USER : options.userId)
    },
    privilegedBusinesses(userId) {
      calls.push(`read memberships ${userId}`)
      return Promise.resolve(
        roles.map((role, index) => ({
          id: index === 0 ? SHOP : OTHER_SHOP,
          name: index === 0 ? 'Demo Barber' : 'Second Shop',
          slug: index === 0 ? 'demo-barber' : 'second-shop',
          timezone: 'Europe/Athens',
          role,
        })),
      )
    },
    listFactors(userId) {
      calls.push(`list factors ${userId}`)
      return Promise.resolve([
        {
          id: F1,
          friendlyName: 'Συσκευή 1',
          status: 'verified',
          createdAt: '2026-09-01T10:00:00Z',
        },
        { id: F2, friendlyName: null, status: 'unverified', createdAt: '2026-09-02T10:00:00Z' },
      ])
    },
    recordSupportAction(input) {
      calls.push(`record_support_action ${input.userId} [${input.ticket}] ${input.reason}`)
      return Promise.resolve({ factorIds: [F1, F2], grants: 2, auditRows: roles.length })
    },
    deleteFactor(userId, factorId) {
      calls.push(`deleteFactor ${userId} ${factorId}`)
      return Promise.resolve(deletes.shift() ?? { ok: true })
    },
    revokeSessions(userId) {
      calls.push(`revoke_user_sessions ${userId}`)
      return Promise.resolve({ sessions: 3, pushSubscriptions: 1 })
    },
    ownerEmails(businessId) {
      calls.push(`owners ${businessId}`)
      return Promise.resolve(['owner@demo-barber.test'])
    },
  }
  return { ports, calls }
}

/** @param {boolean} yes */
function input(yes) {
  /** @type {string[]} */
  const lines = []
  return {
    lines,
    run: {
      email: 'manager-reset@demo-barber.test',
      reason: 'lost phone',
      ticket: 'E2E-1',
      yes,
      now: NOW,
      templates: TEMPLATES,
      /** @param {string} line */
      print: (line) => lines.push(line),
    },
  }
}

const isWrite = (/** @type {string} */ call) =>
  /^(record_support_action|deleteFactor|revoke_user_sessions)/.test(call)

describe('runMfaReset', () => {
  it('only reads in a dry run, and says so', async () => {
    const { ports, calls } = fakePorts()
    const { lines, run } = input(false)
    expect(await runMfaReset(ports, run)).toBe(0)
    expect(calls.filter(isWrite)).toEqual([])
    expect(lines).toContain(
      'Dry run: nothing was written. After the identity check, rerun with --yes.',
    )
    expect(lines.join('\n')).toContain(F1)
    expect(lines.join('\n')).toContain('manager  Demo Barber (/demo-barber)')
  })

  it('with --yes: audit and grants first, then every factor, then every session', async () => {
    const { ports, calls } = fakePorts()
    const { lines, run } = input(true)
    expect(await runMfaReset(ports, run)).toBe(0)
    expect(calls.filter(isWrite)).toEqual([
      `record_support_action ${USER} [E2E-1] lost phone`,
      `deleteFactor ${USER} ${F1}`,
      `deleteFactor ${USER} ${F2}`,
      `revoke_user_sessions ${USER}`,
    ])
    const text = lines.join('\n')
    expect(text).toContain('factors deleted         2')
    expect(text).toContain('sessions revoked        3')
    expect(text).toContain('push devices removed    1')
  })

  it('prints the emails filled in: the user’s, and the owners’ for a manager', async () => {
    const { ports, calls } = fakePorts()
    const { lines, run } = input(true)
    await runMfaReset(ports, run)
    const text = lines.join('\n')
    expect(text).toContain('----- Email to manager-reset@demo-barber.test (el) -----')
    expect(text).toContain('----- Email to manager-reset@demo-barber.test (en) -----')
    expect(text).toContain(
      '----- Email to the owner(s) of Demo Barber: owner@demo-barber.test (el) -----',
    )
    // Only the business where the user is a manager gets an owner email.
    expect(calls.filter((call) => call.startsWith('owners'))).toEqual([`owners ${SHOP}`])
    expect(text).not.toContain('Second Shop: ')
    expect(text).not.toMatch(/\{\{|\}\}/)
    expect(text).toContain('E2E-1')
    expect(text).toContain(formatResetDate(NOW, 'el', 'Europe/Athens'))
  })

  it('refuses an unknown email with exit 1 and writes nothing', async () => {
    const { ports, calls } = fakePorts({ userId: null })
    const { lines, run } = input(true)
    expect(await runMfaReset(ports, run)).toBe(1)
    expect(calls.filter(isWrite)).toEqual([])
    expect(lines.join('\n')).toContain('No account with the email')
  })

  it('refuses a user who is owner or manager nowhere, before any write', async () => {
    const { ports, calls } = fakePorts({ roles: [] })
    expect(await runMfaReset(ports, input(true).run)).toBe(1)
    expect(calls.filter(isWrite)).toEqual([])
  })

  it('counts a factor deleted meanwhile (404) as gone', async () => {
    const { ports } = fakePorts({ deletes: [{ ok: false, status: 404, message: 'not found' }] })
    const { lines, run } = input(true)
    expect(await runMfaReset(ports, run)).toBe(0)
    expect(lines.join('\n')).toContain('factors deleted         1 (+1 already gone)')
  })

  it('still revokes the sessions when a deletion fails, then exits 1 naming the step', async () => {
    const { ports, calls } = fakePorts({ deletes: [{ ok: false, status: 500, message: 'boom' }] })
    const { lines, run } = input(true)
    expect(await runMfaReset(ports, run)).toBe(1)
    expect(calls.filter(isWrite).at(-1)).toBe(`revoke_user_sessions ${USER}`)
    expect(lines.at(-1)).toMatch(
      /^Failed at step delete factors: not deleted: .*Sessions WERE revoked/,
    )
  })

  it('stops at the failing step and names it', async () => {
    const { ports, calls } = fakePorts()
    ports.recordSupportAction = () => Promise.reject(new Error('22023 reason too short'))
    const { lines, run } = input(true)
    expect(await runMfaReset(ports, run)).toBe(1)
    expect(calls.filter(isWrite)).toEqual([])
    expect(lines.at(-1)).toBe('Failed at step record_support_action: 22023 reason too short')
  })
})

describe('resetFactorsWith (the e2e reset)', () => {
  it('returns what it did', async () => {
    const { ports } = fakePorts()
    await expect(
      resetFactorsWith(ports, { userId: USER, reason: 'e2e reset', ticket: 'E2E' }),
    ).resolves.toEqual({
      factorIds: [F1, F2],
      deleted: 2,
      alreadyGone: 0,
      grants: 2,
      auditRows: 2,
      sessions: 3,
      pushSubscriptions: 1,
    })
  })

  it('throws a ResetStepError when a factor is left', async () => {
    const { ports } = fakePorts({ deletes: [{ ok: false, status: 0, message: 'fetch failed' }] })
    await expect(
      resetFactorsWith(ports, { userId: USER, reason: 'e2e reset', ticket: 'E2E' }),
    ).rejects.toThrow(ResetStepError)
  })
})

describe('supportPorts (the calls on the service-role client)', () => {
  it('calls the 0009 RPCs and the Auth admin API with the right arguments', async () => {
    /** @type {Array<[string, unknown]>} */
    const calls = []
    const fake = {
      /** @param {string} fn @param {unknown} args */
      rpc(fn, args) {
        calls.push([fn, args])
        if (fn === 'user_id_for_email') return Promise.resolve({ data: USER, error: null })
        if (fn === 'record_support_action') {
          return Promise.resolve({
            data: { action: 'mfa_reset', factor_ids: [F1], grants: 1, audit_rows: 2 },
            error: null,
          })
        }
        return Promise.resolve({ data: { sessions: 2, push_subscriptions: 0 }, error: null })
      },
      auth: {
        admin: {
          mfa: {
            /** @param {unknown} params */
            deleteFactor(params) {
              calls.push(['deleteFactor', params])
              return Promise.resolve({ data: null, error: { status: 404, message: 'gone' } })
            },
          },
        },
      },
    }
    /** @type {import('./mfa-reset.mjs').Db} */
    const db = /** @type {never} */ (/** @type {unknown} */ (fake))
    const ports = supportPorts(db)
    expect(await ports.userIdForEmail('a@b.gr')).toBe(USER)
    expect(await ports.recordSupportAction({ userId: USER, reason: 'r1x', ticket: 'T-1' })).toEqual(
      { factorIds: [F1], grants: 1, auditRows: 2 },
    )
    expect(await ports.deleteFactor(USER, F1)).toEqual({ ok: false, status: 404, message: 'gone' })
    expect(await ports.revokeSessions(USER)).toEqual({ sessions: 2, pushSubscriptions: 0 })
    expect(calls).toEqual([
      ['user_id_for_email', { p_email: 'a@b.gr' }],
      [
        'record_support_action',
        { p_action: 'mfa_reset', p_reason: 'r1x', p_ticket: 'T-1', p_user_id: USER },
      ],
      ['deleteFactor', { id: F1, userId: USER }],
      ['revoke_user_sessions', { p_user_id: USER }],
    ])
  })
})

describe('email templates', () => {
  it('finds all four in the runbook, without fences or markers', () => {
    for (const id of EMAIL_TEMPLATE_IDS) {
      const text = TEMPLATES[id]
      expect(text.length).toBeGreaterThan(100)
      expect(text).not.toContain('```')
      expect(text).not.toContain('<!--')
      expect(text).toContain('{{ticket}}')
      expect(text).toContain('{{date}}')
      expect(text).toContain('{{email}}')
    }
    expect(TEMPLATES['user:el']).toMatch(/^Θέμα: /)
    expect(TEMPLATES['owner:en']).toMatch(/^Subject: /)
  })

  it('never carries a link, a code or auth jargon', () => {
    for (const id of EMAIL_TEMPLATE_IDS) {
      expect(TEMPLATES[id]).not.toMatch(/https?:|www\.|\/app/i)
      expect(TEMPLATES[id]).not.toMatch(/totp|mfa|2fa/i)
    }
  })

  it('refuses a runbook with a missing template', () => {
    const broken = RUNBOOK.replace('<!-- mfa-reset-email:owner:en -->', '')
    expect(() => extractEmailTemplates(broken)).toThrow(/owner:en/)
  })

  it('fills the known placeholders and refuses any other', () => {
    expect(
      fillTemplate('{{email}} {{ date }} [{{ticket}}]', { email: 'a', date: 'b', ticket: 'c' }),
    ).toBe('a b [c]')
    expect(() => fillTemplate('{{name}}', { email: 'a', date: 'b', ticket: 'c' })).toThrow(
      /Unknown placeholder \{\{name\}\}/,
    )
    // A `$&` in a value is inserted literally.
    expect(fillTemplate('{{email}}', { email: '$&x', date: '', ticket: '' })).toBe('$&x')
  })

  it('writes the date in the business time zone', () => {
    expect(formatResetDate(NOW, 'en', 'Europe/Athens')).toContain('12:30')
    expect(formatResetDate(NOW, 'en', 'Europe/Lisbon')).toContain('10:30')
  })
})

describe('parseMfaResetArgs', () => {
  const required = ['--email', ' Manager@Shop.GR ', '--reason', 'lost phone', '--ticket', 'NOUS-1']

  it('needs email, reason and ticket; normalises the email', () => {
    expect(parseMfaResetArgs([...required, '--local'])).toEqual({
      help: false,
      email: 'manager@shop.gr',
      reason: 'lost phone',
      ticket: 'NOUS-1',
      local: true,
      prod: false,
      'project-ref': undefined,
      'env-file': undefined,
      yes: false,
    })
    expect(parseMfaResetArgs(['--help'])).toEqual({ help: true })
  })

  it.each([
    [['--local', '--email', 'a@b.gr', '--reason', 'xyz', '--ticket', 'T', '--force']],
    [['--local', 'a@b.gr']],
    [['--reason', 'lost phone', '--ticket', 'NOUS-1']],
    [['--email', 'nope', '--reason', 'lost phone', '--ticket', 'NOUS-1']],
    [['--email', 'a@b.gr', '--ticket', 'NOUS-1']],
    [['--email', 'a@b.gr', '--reason', 'lost phone']],
    [['--email', 'a@b.gr', '--reason', 'lost phone', '--ticket', 'two words']],
  ])('refuses %j with a usage error', (argv) => {
    expect(() => parseMfaResetArgs(argv)).toThrow(UsageError)
  })

  it('exits 2 on an unknown option, with --local and before any connection', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'mfa-reset.mjs'), '--local', '--no-such-option'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 },
    )
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("Unknown option '--no-such-option'")
    // A cold node start with supabase-js can take seconds while the whole suite runs.
  }, 30_000)
})
