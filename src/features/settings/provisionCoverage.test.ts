import { beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod/mini'
import { ServiceFormSchema } from '@/features/services/schema'
import { StaffFormSchema } from '@/features/staff/schema'
import { WeekHoursFormSchema } from '@/features/staff/weekHours'
import { BookingPolicyFormSchema } from './policySchema'
import {
  covers,
  PROVISION_COVERAGE,
  SCREEN_ONLY_FORM_KEYS,
  type CoverageForm,
} from './provisionCoverage'

type Schema = z.core.$ZodType

const FORMS: Record<CoverageForm, Schema> = {
  BookingPolicyFormSchema,
  ServiceFormSchema,
  StaffFormSchema,
  WeekHoursFormSchema,
}

/**
 * The provisioning schema lives in scripts/ (plain .mjs, outside this project's TypeScript
 * program): loaded at run time and checked to be a zod schema before it is walked.
 */
async function provisionFile(): Promise<Schema> {
  const path = '../../../scripts/lib/provision-schema.mjs'
  const module: unknown = await import(/* @vite-ignore */ path)
  const schema: unknown =
    typeof module === 'object' && module !== null && 'ProvisionFile' in module
      ? module.ProvisionFile
      : null
  if (!isSchema(schema)) throw new Error('scripts/lib/provision-schema.mjs: no ProvisionFile')
  return schema
}

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && '_zod' in value
}

/** The object shape of a schema (through optional/nullable/default wrappers), or null. */
function shapeOf(schema: Schema): Record<string, Schema> | null {
  const def = schema._zod.def
  switch (def.type) {
    case 'object':
      return (def as z.core.$ZodObjectDef).shape
    case 'optional':
    case 'nullable':
    case 'default':
    case 'nonoptional':
    case 'readonly':
      return shapeOf((def as z.core.$ZodOptionalDef).innerType)
    default:
      return null
  }
}

/** Every leaf path of a schema: object keys joined with '.', `[]` for list items. */
function leafPaths(schema: Schema, path = ''): string[] {
  const def = schema._zod.def
  switch (def.type) {
    case 'object':
      return Object.entries((def as z.core.$ZodObjectDef).shape).flatMap(([key, child]) =>
        leafPaths(child, path ? `${path}.${key}` : key),
      )
    case 'optional':
    case 'nullable':
    case 'default':
    case 'nonoptional':
    case 'readonly':
      return leafPaths((def as z.core.$ZodOptionalDef).innerType, path)
    case 'array':
      return leafPaths((def as z.core.$ZodArrayDef).element, `${path}[]`)
    case 'union':
      return [
        ...new Set(
          (def as z.core.$ZodUnionDef).options.flatMap((option) => leafPaths(option, path)),
        ),
      ]
    case 'pipe':
      return leafPaths((def as z.core.$ZodPipeDef).in, path)
    default:
      return [path]
  }
}

/** Whether a dotted key exists in a form schema's (nested) object shape. */
function hasKey(schema: Schema, key: string): boolean {
  let current: Schema | undefined = schema
  for (const part of key.split('.')) {
    const shape: Record<string, Schema> | null = current ? shapeOf(current) : null
    current = shape?.[part]
    if (!current) return false
  }
  return true
}

describe('provisioning JSON ⇄ settings screens (contract 1.6 §5.1)', () => {
  let leaves: string[] = []

  // Loading the script module (and the zod schemas it builds) can take seconds in a full run.
  beforeAll(async () => {
    leaves = leafPaths(await provisionFile())
  }, 30_000)

  it('every field of the provisioning file has an entry', () => {
    expect(leaves.length).toBeGreaterThan(30)
    const missing = leaves.filter(
      (leaf) => !PROVISION_COVERAGE.some((entry) => covers(entry.path, leaf)),
    )
    expect(missing).toEqual([])
  })

  it('every entry names a field the provisioning file has (no stale entries)', () => {
    const stale = PROVISION_COVERAGE.filter(
      (entry) => !leaves.some((leaf) => covers(entry.path, leaf)),
    ).map((entry) => entry.path)
    expect(stale).toEqual([])
  })

  it('every screen entry names a key of the form schema it cites', () => {
    const wrong = PROVISION_COVERAGE.flatMap((entry) =>
      'form' in entry && !hasKey(FORMS[entry.form], entry.key)
        ? [`${entry.form}.${entry.key}`]
        : [],
    )
    expect(wrong).toEqual([])
  })

  it('every key of those form schemas is mapped or listed as screen-only', () => {
    const unmapped = (Object.keys(FORMS) as CoverageForm[]).flatMap((form) => {
      const keys = Object.keys(shapeOf(FORMS[form]) ?? {})
      return keys
        .filter(
          (key) =>
            !SCREEN_ONLY_FORM_KEYS[form].includes(key) &&
            !PROVISION_COVERAGE.some(
              (entry) =>
                'form' in entry &&
                entry.form === form &&
                (entry.key === key || entry.key.startsWith(`${key}.`)),
            ),
        )
        .map((key) => `${form}.${key}`)
    })
    expect(unmapped).toEqual([])
  })

  it('the walk sees nested and list fields (a sanity check of the test itself)', () => {
    expect(leaves).toContain('business.policy.slot_step_min')
    expect(leaves).toContain('staff[].hours.mon[]')
    expect(leaves).toContain('staff[].services[].custom_price_cents')
    expect(leaves).toContain('services[].price_cents')
  })
})
