// The Nous reset of a user's authenticator devices (break-glass, ADR-0009 §17, runbook
// docs/runbooks/mfa-reset.md, contract 1.7 §5.1): the pure parts of scripts/mfa-reset.mjs, on
// injected ports, so Vitest proves the order of the calls (mfa-reset.test.mjs). The e2e helpers
// reuse `resetUserFactors` on the local stack.
//
// Order with --yes: user_id_for_email → record_support_action('mfa_reset') (a `remove` grant per
// factor and an audit row per business, BEFORE anything is deleted, so the 1.9 detector never
// flags it) → auth.admin.mfa.deleteFactor for each → revoke_user_sessions. Without --yes: a dry
// run that only reads. Never reads or prints a TOTP secret (the admin API does not return it).
import { parseArgs } from 'node:util'
import { z } from 'zod/mini'
import { UsageError, parseSupportInput } from './cli.mjs'

/**
 * @typedef {import('@supabase/supabase-js').SupabaseClient<import('../../src/shared/lib/database.types.ts').Database>} Db
 * @typedef {'owner' | 'manager'} PrivilegedRole
 * @typedef {{ id: string, name: string, slug: string, timezone: string, role: PrivilegedRole }} PrivilegedBusiness
 * @typedef {{ id: string, friendlyName: string | null, status: string, createdAt: string }} FactorInfo
 * @typedef {{ factorIds: string[], grants: number, auditRows: number }} SupportRecord
 * @typedef {{ ok: true } | { ok: false, status: number, message: string }} DeleteOutcome
 * @typedef {{ sessions: number, pushSubscriptions: number }} Revoked
 */

/**
 * Everything the reset reads and writes, as the service role. Errors are thrown.
 * @typedef {object} MfaResetPorts
 * @property {(email: string) => Promise<string | null>} userIdForEmail
 * @property {(userId: string) => Promise<PrivilegedBusiness[]>} privilegedBusinesses
 * @property {(userId: string) => Promise<FactorInfo[]>} listFactors ids, names, statuses: never secrets
 * @property {(input: { userId: string, reason: string, ticket: string }) => Promise<SupportRecord>} recordSupportAction
 * @property {(userId: string, factorId: string) => Promise<DeleteOutcome>} deleteFactor
 * @property {(userId: string) => Promise<Revoked>} revokeSessions
 * @property {(businessId: string) => Promise<string[]>} ownerEmails
 */

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 254

/**
 * @typedef {object} MfaResetArgs
 * @property {false} help
 * @property {string} email trimmed, lower-cased
 * @property {string} reason
 * @property {string} ticket
 * @property {boolean} local
 * @property {boolean} prod
 * @property {string} [project-ref]
 * @property {string} [env-file]
 * @property {boolean} yes
 */

/**
 * Strict: an unknown option, a positional or a missing/malformed --email, --reason or --ticket
 * throws a UsageError (exit 2) before anything is read or any connection is made.
 * @param {readonly string[]} argv the arguments after the script name
 * @returns {MfaResetArgs | { help: true }}
 */
export function parseMfaResetArgs(argv) {
  let values
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        email: { type: 'string' },
        reason: { type: 'string' },
        ticket: { type: 'string' },
        local: { type: 'boolean', default: false },
        prod: { type: 'boolean', default: false },
        'project-ref': { type: 'string' },
        'env-file': { type: 'string' },
        yes: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  if (values.help) return { help: true }

  const email = values.email?.trim().toLowerCase() ?? ''
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) {
    throw new UsageError('--email <the account’s address> is required.')
  }
  const { reason, ticket } = parseSupportInput(values)
  return {
    help: false,
    email,
    reason,
    ticket,
    local: values.local,
    prod: values.prod,
    'project-ref': values['project-ref'],
    'env-file': values['env-file'],
    yes: values.yes,
  }
}

// ---------------------------------------------------------------------------------------------
// Email templates (they live in the runbook, between markers)
// ---------------------------------------------------------------------------------------------

export const EMAIL_TEMPLATE_IDS = /** @type {const} */ ([
  'user:el',
  'user:en',
  'owner:el',
  'owner:en',
])
/** @typedef {(typeof EMAIL_TEMPLATE_IDS)[number]} EmailTemplateId */
/** @typedef {Record<EmailTemplateId, string>} EmailTemplates */

export const TEMPLATE_PLACEHOLDERS = /** @type {const} */ (['email', 'date', 'ticket'])
/** @typedef {Record<(typeof TEMPLATE_PLACEHOLDERS)[number], string>} TemplateValues */

const END_MARKER = '<!-- /mfa-reset-email -->'

/**
 * The four texts between `<!-- mfa-reset-email:<id> -->` and `<!-- /mfa-reset-email -->` of the
 * runbook; a surrounding ``` fence is dropped. Throws when one is missing, empty or repeated, so
 * a broken runbook is caught before the script connects.
 * @param {string} markdown
 * @returns {EmailTemplates}
 */
export function extractEmailTemplates(markdown) {
  const text = markdown.replace(/\r\n/g, '\n')
  /** @type {Partial<EmailTemplates>} */
  const templates = {}
  for (const id of EMAIL_TEMPLATE_IDS) {
    const start = `<!-- mfa-reset-email:${id} -->`
    const first = text.indexOf(start)
    if (first === -1) throw new Error(`The runbook has no email template ${id}.`)
    if (text.indexOf(start, first + start.length) !== -1) {
      throw new Error(`The runbook has the email template ${id} twice.`)
    }
    const end = text.indexOf(END_MARKER, first)
    if (end === -1) throw new Error(`The email template ${id} has no end marker.`)
    const body = text
      .slice(first + start.length, end)
      .trim()
      .replace(/^```[\w-]*\n/, '')
      .replace(/\n```$/, '')
      .trim()
    if (body === '') throw new Error(`The email template ${id} is empty.`)
    templates[id] = body
  }
  return /** @type {EmailTemplates} */ (templates)
}

/**
 * Replaces `{{email}}`, `{{date}}` and `{{ticket}}`. Any other `{{…}}` is a mistake in the
 * runbook and throws (an email must never go out with a placeholder in it).
 * @param {string} text
 * @param {TemplateValues} values
 */
export function fillTemplate(text, values) {
  return text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_match, /** @type {string} */ name) => {
    if (!Object.hasOwn(values, name))
      throw new Error(`Unknown placeholder {{${name}}} in a template.`)
    return values[/** @type {keyof TemplateValues} */ (name)]
  })
}

/**
 * The reset's date for an email, in the business's own time zone (never a hard-coded one).
 * @param {Date} at
 * @param {'el' | 'en'} locale
 * @param {string} timeZone
 */
export function formatResetDate(at, locale, timeZone) {
  return new Intl.DateTimeFormat(locale === 'el' ? 'el-GR' : 'en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone,
  }).format(at)
}

// ---------------------------------------------------------------------------------------------
// Ports over supabase-js (service role)
// ---------------------------------------------------------------------------------------------

const Uuid = z.guid()
const SupportActionResult = z.object({
  factor_ids: z.array(Uuid),
  grants: z.int().check(z.gte(0)),
  audit_rows: z.int().check(z.gte(0)),
})
const RevokeResult = z.object({
  sessions: z.int().check(z.gte(0)),
  push_subscriptions: z.int().check(z.gte(0)),
})
const PRIVILEGED_ROLES = /** @type {const} */ (['owner', 'manager'])

/**
 * @param {string} what
 * @param {{ message: string } | null} error
 */
function check(what, error) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

/**
 * The ports on a service-role client (`provisionLocal`-style for the e2e, or the CLI's).
 * @param {Db} db
 * @returns {MfaResetPorts}
 */
export function supportPorts(db) {
  return {
    async userIdForEmail(email) {
      const { data, error } = await db.rpc('user_id_for_email', { p_email: email })
      check('user_id_for_email', error)
      return z.nullable(Uuid).parse(data)
    },

    async privilegedBusinesses(userId) {
      const members = await db
        .from('business_members')
        .select('business_id, role')
        .eq('user_id', userId)
        .in('role', [...PRIVILEGED_ROLES])
      check('read business_members', members.error)
      const rows = members.data ?? []
      if (rows.length === 0) return []
      const businesses = await db
        .from('businesses')
        .select('id, name, slug, timezone')
        .in(
          'id',
          rows.map((row) => row.business_id),
        )
      check('read businesses', businesses.error)
      return (businesses.data ?? [])
        .map((business) => {
          const role = rows.find((row) => row.business_id === business.id)?.role
          return {
            ...business,
            role: /** @type {PrivilegedRole} */ (role === 'owner' ? 'owner' : 'manager'),
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    },

    async listFactors(userId) {
      const { data, error } = await db.auth.admin.mfa.listFactors({ userId })
      check('list factors', error)
      return (data?.factors ?? []).map((factor) => ({
        id: factor.id,
        friendlyName: factor.friendly_name ?? null,
        status: factor.status,
        createdAt: factor.created_at,
      }))
    },

    async recordSupportAction({ userId, reason, ticket }) {
      const { data, error } = await db.rpc('record_support_action', {
        p_action: 'mfa_reset',
        p_reason: reason,
        p_ticket: ticket,
        p_user_id: userId,
      })
      check('record_support_action', error)
      const parsed = SupportActionResult.parse(data)
      return {
        factorIds: parsed.factor_ids,
        grants: parsed.grants,
        auditRows: parsed.audit_rows,
      }
    },

    async deleteFactor(userId, factorId) {
      const { error } = await db.auth.admin.mfa.deleteFactor({ id: factorId, userId })
      return error === null
        ? { ok: true }
        : { ok: false, status: error.status ?? 0, message: error.message }
    },

    async revokeSessions(userId) {
      const { data, error } = await db.rpc('revoke_user_sessions', { p_user_id: userId })
      check('revoke_user_sessions', error)
      const parsed = RevokeResult.parse(data)
      return { sessions: parsed.sessions, pushSubscriptions: parsed.push_subscriptions }
    },

    async ownerEmails(businessId) {
      const owners = await db
        .from('business_members')
        .select('user_id')
        .eq('business_id', businessId)
        .eq('role', 'owner')
      check('read the owners', owners.error)
      /** @type {string[]} */
      const emails = []
      for (const { user_id: id } of owners.data ?? []) {
        const { data, error } = await db.auth.admin.getUserById(id)
        check('read an owner', error)
        if (data.user?.email) emails.push(data.user.email)
      }
      return emails.sort()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The reset (steps 2–4) and the whole run
// ---------------------------------------------------------------------------------------------

/** A step of the reset failed; `step` names it for the operator (and the exit message). */
export class ResetStepError extends Error {
  /**
   * @param {string} step
   * @param {string} message
   */
  constructor(step, message) {
    super(`${step}: ${message}`)
    this.step = step
  }
}

/**
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function step(name, run) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ResetStepError) throw error
    throw new ResetStepError(name, error instanceof Error ? error.message : String(error))
  }
}

/**
 * @typedef {object} ResetResult
 * @property {string[]} factorIds the factors the grants were written for
 * @property {number} deleted
 * @property {number} alreadyGone deleted meanwhile (404)
 * @property {number} grants
 * @property {number} auditRows
 * @property {number} sessions
 * @property {number} pushSubscriptions
 */

/**
 * Steps 2–4 of the runbook: grants and audit rows first, then every factor, then every session.
 * The sessions are revoked even when a factor could not be deleted (then it throws afterwards,
 * naming the step), so a lost device never keeps a live session.
 * @param {MfaResetPorts} ports
 * @param {{ userId: string, reason: string, ticket: string }} input
 * @returns {Promise<ResetResult>}
 */
export async function resetFactorsWith(ports, input) {
  const recorded = await step('record_support_action', () => ports.recordSupportAction(input))
  let deleted = 0
  let alreadyGone = 0
  /** @type {string[]} */
  const failures = []
  for (const factorId of recorded.factorIds) {
    const outcome = await step('delete factors', () => ports.deleteFactor(input.userId, factorId))
    if (outcome.ok) deleted++
    else if (outcome.status === 404) alreadyGone++
    else failures.push(`${factorId} (${outcome.status || 'no answer'}: ${outcome.message})`)
  }
  const revoked = await step('revoke_user_sessions', () => ports.revokeSessions(input.userId))
  if (failures.length > 0) {
    throw new ResetStepError(
      'delete factors',
      `not deleted: ${failures.join(', ')}. Sessions WERE revoked; rerun with the same ticket.`,
    )
  }
  return {
    factorIds: recorded.factorIds,
    deleted,
    alreadyGone,
    grants: recorded.grants,
    auditRows: recorded.auditRows,
    sessions: revoked.sessions,
    pushSubscriptions: revoked.pushSubscriptions,
  }
}

/**
 * `resetFactorsWith` on a service-role client (the e2e helpers' `resetFactors`).
 * @param {Db} db
 * @param {{ userId: string, reason: string, ticket: string }} input
 */
export function resetUserFactors(db, input) {
  return resetFactorsWith(supportPorts(db), input)
}

/**
 * @typedef {object} RunInput
 * @property {string} email
 * @property {string} reason
 * @property {string} ticket
 * @property {boolean} yes false = dry run: reads only
 * @property {Date} now
 * @property {EmailTemplates} templates
 * @property {(line: string) => void} print
 */

/**
 * @param {FactorInfo} factor
 */
function describeFactor(factor) {
  return `${factor.id}  ${factor.status.padEnd(10)}  ${factor.friendlyName ?? '(no name)'}  added ${factor.createdAt}`
}

/**
 * @param {RunInput} input
 * @param {string} heading
 * @param {string} text
 */
function printEmail(input, heading, text) {
  input.print('')
  input.print(`----- ${heading} -----`)
  for (const line of text.split('\n')) input.print(line)
}

/**
 * The whole script after its arguments: the plan (always), then with `yes` the reset and the
 * emails to send, filled in. Returns the exit code: 0 done (or dry run), 1 refused or failed.
 * @param {MfaResetPorts} ports
 * @param {RunInput} input
 * @returns {Promise<0 | 1>}
 */
export async function runMfaReset(ports, input) {
  const { print } = input
  try {
    const userId = await step('user_id_for_email', () => ports.userIdForEmail(input.email))
    if (userId === null) {
      print(`No account with the email ${input.email}. Nothing was written.`)
      return 1
    }
    const businesses = await step('read memberships', () => ports.privilegedBusinesses(userId))
    if (businesses.length === 0) {
      print(
        `${input.email} is not an owner or a manager anywhere: there are no devices to reset. ` +
          'Nothing was written.',
      )
      return 1
    }
    const factors = await step('list factors', () => ports.listFactors(userId))

    print(`User      ${input.email} (${userId})`)
    print(`Ticket    [${input.ticket}] ${input.reason}`)
    print('Owner or manager of:')
    for (const business of businesses) {
      print(`  ${business.role.padEnd(8)} ${business.name} (/${business.slug})`)
    }
    print(`Authenticator devices (${factors.length}):`)
    for (const factor of factors) print(`  ${describeFactor(factor)}`)
    if (!input.yes) {
      print('')
      print('Dry run: nothing was written. After the identity check, rerun with --yes.')
      return 0
    }

    const result = await resetFactorsWith(ports, {
      userId,
      reason: input.reason,
      ticket: input.ticket,
    })
    print('')
    print('Done:')
    print(`  grants (nous_support)   ${result.grants}`)
    print(`  audit_log rows          ${result.auditRows}`)
    print(
      `  factors deleted         ${result.deleted}` +
        (result.alreadyGone > 0 ? ` (+${result.alreadyGone} already gone)` : ''),
    )
    print(`  sessions revoked        ${result.sessions}`)
    print(`  push devices removed    ${result.pushSubscriptions}`)

    const zone = businesses[0]?.timezone ?? 'UTC'
    for (const locale of /** @type {const} */ (['el', 'en'])) {
      const values = {
        email: input.email,
        date: formatResetDate(input.now, locale, zone),
        ticket: input.ticket,
      }
      printEmail(
        input,
        `Email to ${input.email} (${locale})`,
        fillTemplate(input.templates[`user:${locale}`], values),
      )
    }
    for (const business of businesses.filter((entry) => entry.role === 'manager')) {
      const owners = await step('read the owners (the reset itself is complete)', () =>
        ports.ownerEmails(business.id),
      )
      for (const locale of /** @type {const} */ (['el', 'en'])) {
        const values = {
          email: input.email,
          date: formatResetDate(input.now, locale, business.timezone),
          ticket: input.ticket,
        }
        printEmail(
          input,
          `Email to the owner(s) of ${business.name}: ${owners.join(', ') || '(none found)'} (${locale})`,
          fillTemplate(input.templates[`owner:${locale}`], values),
        )
      }
    }
    return 0
  } catch (error) {
    print(
      error instanceof ResetStepError
        ? `Failed at step ${error.message}`
        : `Failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
}
