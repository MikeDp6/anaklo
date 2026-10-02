// The command line of provision-business.mjs, parsed before anything else runs: an unknown
// option or a malformed --reason/--ticket is a UsageError (exit 2) before any file is read or any
// connection is made. Vitest: provision-args.test.mjs.
import { parseArgs } from 'node:util'
import { UsageError, parseSupportInput } from './cli.mjs'

/**
 * What a `--local` run records when no --reason/--ticket is given (contract 1.7 D14): the local
 * stack is the developer's own, and its audit rows only show that the script ran.
 */
export const LOCAL_SUPPORT = Object.freeze({ reason: 'local provisioning', ticket: 'LOCAL' })

/**
 * @typedef {object} ProvisionArgs
 * @property {string} [file]
 * @property {boolean} local
 * @property {boolean} prod
 * @property {string} [project-ref]
 * @property {string} [env-file]
 * @property {boolean} validate
 * @property {boolean} help
 * @property {{ reason: string, ticket: string } | undefined} support the audit of a change to an
 *   existing business (`record_support_action('provision_update')`); undefined = none given
 */

/**
 * @param {readonly string[]} argv the arguments after the script name
 * @returns {ProvisionArgs}
 */
export function parseProvisionArgs(argv) {
  let values
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        file: { type: 'string' },
        local: { type: 'boolean', default: false },
        prod: { type: 'boolean', default: false },
        'project-ref': { type: 'string' },
        'env-file': { type: 'string' },
        reason: { type: 'string' },
        ticket: { type: 'string' },
        validate: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { reason, ticket, ...rest } = values
  /** @type {{ reason: string, ticket: string } | undefined} */
  let support
  if (reason !== undefined || ticket !== undefined) {
    support = parseSupportInput({ reason, ticket })
  } else if (rest.local) {
    support = LOCAL_SUPPORT
  }
  return { ...rest, support }
}
