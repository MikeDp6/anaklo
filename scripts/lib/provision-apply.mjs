// Writes a validated provisioning file with the secret key. As service_role it bypasses RLS and
// the aal2 policies (ADR-0009 §8): a Nous tool, never exposed anywhere. Idempotent by slug: it
// reads everything first, refuses conflicts before the first write (checked against the final
// state), then changes only what differs, in an order that passes the constraints after every
// single request. It never writes appointments (they go through RPCs that declare an actor).
import {
  BUSINESS_UPDATABLE,
  createOnlyConflicts,
  diffMembers,
  diffStaffServices,
  indexByName,
  patchFor,
  planMemberWrites,
  sameHours,
  staffLinkConflicts,
  toDbTime,
} from './provision-diff.mjs'

/**
 * @typedef {import('../../src/shared/lib/database.types.ts').Database} Database
 * @typedef {import('@supabase/supabase-js').SupabaseClient<Database>} Db
 * @typedef {import('./provision-schema.mjs').Desired} Desired
 * @typedef {{ created: number, updated: number, unchanged: number, removed: number }} Count
 * @typedef {object} Summary
 * @property {'created' | 'updated' | 'unchanged'} business
 * @property {Record<'categories' | 'services' | 'staff' | 'staff_services' | 'working_hours' | 'auth_users' | 'members', Count>} counts
 * @property {string[]} notInFile rows in the database that the file does not mention (left as is)
 */

/** Refused before anything was written. */
export class ProvisionConflict extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(problems.join('\n'))
    this.problems = problems
  }
}

/**
 * @param {string} what
 * @param {{ message: string }} error
 */
function dbError(what, error) {
  return new Error(`${what}: ${error.message}`)
}

/** @returns {Count} */
const count = () => ({ created: 0, updated: 0, unchanged: 0, removed: 0 })

/**
 * Every Auth user by lower-cased email. There is no lookup RPC yet (user_id_for_email, 1.7), so
 * the admin API is paged through.
 * @param {Db} db
 */
async function usersByEmail(db) {
  const perPage = 1000
  /** @type {Map<string, string>} */
  const byEmail = new Map()
  for (let page = 1; page <= 1000; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage })
    if (error) throw dbError('list Auth users', error)
    for (const user of data.users) {
      if (user.email) byEmail.set(user.email.toLowerCase(), user.id)
    }
    if (data.users.length < perPage) return byEmail
  }
  throw new Error('list Auth users: too many pages')
}

/**
 * @param {Db} db
 * @param {string} businessId
 */
async function readBusinessState(db, businessId) {
  const [categories, services, staff, staffServices, hours, members] = await Promise.all([
    db.from('service_categories').select('id, name, sort').eq('business_id', businessId),
    db
      .from('services')
      .select(
        'id, name, category_id, duration_min, buffer_after_min, price_cents, online_bookable, active, sort',
      )
      .eq('business_id', businessId),
    db.from('staff').select('id, display_name, color, sort, active').eq('business_id', businessId),
    db
      .from('staff_services')
      .select('staff_id, service_id, custom_duration_min, custom_price_cents')
      .eq('business_id', businessId),
    db
      .from('working_hours')
      .select('staff_id, weekday, start_time, end_time')
      .eq('business_id', businessId),
    db.from('business_members').select('user_id, role, staff_id').eq('business_id', businessId),
  ])
  if (categories.error) throw dbError('read categories', categories.error)
  if (services.error) throw dbError('read services', services.error)
  if (staff.error) throw dbError('read staff', staff.error)
  if (staffServices.error) throw dbError('read staff_services', staffServices.error)
  if (hours.error) throw dbError('read working_hours', hours.error)
  if (members.error) throw dbError('read business_members', members.error)
  return {
    categories: categories.data,
    services: services.data,
    staff: staff.data,
    staffServices: staffServices.data,
    hours: hours.data,
    members: members.data,
  }
}

/** @typedef {Awaited<ReturnType<typeof readBusinessState>>} BusinessState */

/** @type {BusinessState} */
const EMPTY_STATE = {
  categories: [],
  services: [],
  staff: [],
  staffServices: [],
  hours: [],
  members: [],
}

/**
 * @template T
 * @param {Map<string, T>} map
 * @param {string} key
 * @param {string} what
 * @returns {T}
 */
function required(map, key, what) {
  const value = map.get(key)
  if (value === undefined) throw new Error(`internal: no id for ${what} "${key}"`)
  return value
}

/**
 * Makes the database match `desired`. Throws ProvisionConflict (nothing written) or Error.
 * @param {Db} db
 * @param {Desired} desired
 * @returns {Promise<Summary>}
 */
export async function provisionBusiness(db, desired) {
  // 1. Read everything.
  const found = await db
    .from('businesses')
    .select('*')
    .eq('slug', desired.business.slug)
    .maybeSingle()
  if (found.error) throw dbError('read business', found.error)
  const existing = found.data
  const state = existing ? await readBusinessState(db, existing.id) : EMPTY_STATE
  const users = await usersByEmail(db)
  /** @type {Map<string, string>} */
  const emailOf = new Map([...users].map(([email, id]) => [id, email]))

  // 2. Refuse before the first write.
  const categories = indexByName(
    state.categories,
    (row) => row.name,
    'category',
    new Set(desired.categories.map((row) => row.name)),
  )
  const services = indexByName(
    state.services,
    (row) => row.name,
    'service',
    new Set(desired.services.map((row) => row.name)),
  )
  const staff = indexByName(
    state.staff,
    (row) => row.display_name,
    'staff member',
    new Set(desired.staff.map((row) => row.display_name)),
  )
  const problems = [
    ...(existing ? createOnlyConflicts(existing, desired.business) : []),
    ...categories.problems,
    ...services.problems,
    ...staff.problems,
    // Against the final state, new users included (a staff member created by this run is free).
    ...staffLinkConflicts(
      state.members,
      desired.members.map((member) => {
        const staffRow = member.staff === null ? undefined : staff.byName.get(member.staff)
        return {
          user_id: users.get(member.email) ?? null,
          staff_id: staffRow?.id ?? null,
          staffName: member.staff,
        }
      }),
      (userId) => emailOf.get(userId) ?? userId,
    ),
  ]
  if (problems.length > 0) throw new ProvisionConflict(problems)

  /** @type {Summary} */
  const summary = {
    business: 'unchanged',
    counts: {
      categories: count(),
      services: count(),
      staff: count(),
      staff_services: count(),
      working_hours: count(),
      auth_users: count(),
      members: count(),
    },
    notInFile: [
      ...categories.notInFile.map((name) => `category "${name}"`),
      ...services.notInFile.map((name) => `service "${name}"`),
      ...staff.notInFile.map((name) => `staff "${name}"`),
    ],
  }
  const { counts } = summary

  // 3. Business.
  /** @type {string} */
  let businessId
  if (!existing) {
    const { data, error } = await db
      .from('businesses')
      .insert(desired.business)
      .select('id')
      .single()
    if (error) throw dbError('create business', error)
    businessId = data.id
    summary.business = 'created'
  } else {
    businessId = existing.id
    const patch = patchFor(existing, desired.business, BUSINESS_UPDATABLE)
    if (Object.keys(patch).length > 0) {
      const { error } = await db.from('businesses').update(patch).eq('id', businessId)
      if (error) throw dbError('update business', error)
      summary.business = 'updated'
    }
  }

  // 4. Categories.
  /** @type {Map<string, string>} */
  const categoryIds = new Map()
  for (const category of desired.categories) {
    const current = categories.byName.get(category.name)
    if (!current) {
      const { data, error } = await db
        .from('service_categories')
        .insert({ business_id: businessId, ...category })
        .select('id')
        .single()
      if (error) throw dbError(`create category "${category.name}"`, error)
      categoryIds.set(category.name, data.id)
      counts.categories.created++
      continue
    }
    categoryIds.set(category.name, current.id)
    const patch = patchFor(current, category, ['sort'])
    if (Object.keys(patch).length === 0) {
      counts.categories.unchanged++
      continue
    }
    const { error } = await db.from('service_categories').update(patch).eq('id', current.id)
    if (error) throw dbError(`update category "${category.name}"`, error)
    counts.categories.updated++
  }

  // 5. Services.
  /** @type {Map<string, string>} */
  const serviceIds = new Map()
  for (const service of desired.services) {
    const { name, category, ...rest } = service
    const row = {
      ...rest,
      category_id: category === null ? null : required(categoryIds, category, 'category'),
    }
    const current = services.byName.get(name)
    if (!current) {
      const { data, error } = await db
        .from('services')
        .insert({ business_id: businessId, name, ...row })
        .select('id')
        .single()
      if (error) throw dbError(`create service "${name}"`, error)
      serviceIds.set(name, data.id)
      counts.services.created++
      continue
    }
    serviceIds.set(name, current.id)
    const patch = patchFor(current, row, /** @type {Array<keyof typeof row>} */ (Object.keys(row)))
    if (Object.keys(patch).length === 0) {
      counts.services.unchanged++
      continue
    }
    const { error } = await db.from('services').update(patch).eq('id', current.id)
    if (error) throw dbError(`update service "${name}"`, error)
    counts.services.updated++
  }

  // 6. Staff (with or without a login: some exist only for the calendar).
  /** @type {Map<string, string>} */
  const staffIds = new Map()
  for (const person of desired.staff) {
    const row = { sort: person.sort, color: person.color, active: person.active }
    const current = staff.byName.get(person.display_name)
    if (!current) {
      const { data, error } = await db
        .from('staff')
        .insert({ business_id: businessId, display_name: person.display_name, ...row })
        .select('id')
        .single()
      if (error) throw dbError(`create staff "${person.display_name}"`, error)
      staffIds.set(person.display_name, data.id)
      counts.staff.created++
      continue
    }
    staffIds.set(person.display_name, current.id)
    const patch = patchFor(current, row, ['sort', 'color', 'active'])
    if (Object.keys(patch).length === 0) {
      counts.staff.unchanged++
      continue
    }
    const { error } = await db.from('staff').update(patch).eq('id', current.id)
    if (error) throw dbError(`update staff "${person.display_name}"`, error)
    counts.staff.updated++
  }

  // 7. Who offers what (only for staff whose `services` the file states).
  for (const person of desired.staff) {
    if (person.services === undefined) continue
    const staffId = required(staffIds, person.display_name, 'staff')
    const wanted = person.services.map((entry) => ({
      service_id: required(serviceIds, entry.service, 'service'),
      custom_duration_min: entry.custom_duration_min,
      custom_price_cents: entry.custom_price_cents,
    }))
    const diff = diffStaffServices(
      state.staffServices.filter((row) => row.staff_id === staffId),
      wanted,
    )
    const where = `staff_services of "${person.display_name}"`
    if (diff.remove.length > 0) {
      const { error } = await db
        .from('staff_services')
        .delete()
        .eq('business_id', businessId)
        .eq('staff_id', staffId)
        .in('service_id', diff.remove)
      if (error) throw dbError(`remove ${where}`, error)
    }
    if (diff.insert.length > 0) {
      const { error } = await db
        .from('staff_services')
        .insert(diff.insert.map((row) => ({ business_id: businessId, staff_id: staffId, ...row })))
      if (error) throw dbError(`add ${where}`, error)
    }
    for (const row of diff.update) {
      const { error } = await db
        .from('staff_services')
        .update({
          custom_duration_min: row.custom_duration_min,
          custom_price_cents: row.custom_price_cents,
        })
        .eq('business_id', businessId)
        .eq('staff_id', staffId)
        .eq('service_id', row.service_id)
      if (error) throw dbError(`update ${where}`, error)
    }
    const c = counts.staff_services
    c.created += diff.insert.length
    c.updated += diff.update.length
    c.removed += diff.remove.length
    c.unchanged += wanted.length - diff.insert.length - diff.update.length
  }

  // 8. Weekly hours: delete-then-insert per staff member, only when they differ
  // (working_hours_no_overlap is not deferrable; the schema already rejected overlaps).
  for (const person of desired.staff) {
    if (person.hours === undefined) continue
    const staffId = required(staffIds, person.display_name, 'staff')
    const current = state.hours.filter((row) => row.staff_id === staffId)
    if (sameHours(current, person.hours)) {
      counts.working_hours.unchanged++
      continue
    }
    const where = `working hours of "${person.display_name}"`
    const removed = await db
      .from('working_hours')
      .delete()
      .eq('business_id', businessId)
      .eq('staff_id', staffId)
    if (removed.error) throw dbError(`replace ${where}`, removed.error)
    if (person.hours.length > 0) {
      const { error } = await db.from('working_hours').insert(
        person.hours.map((row) => ({
          business_id: businessId,
          staff_id: staffId,
          weekday: row.weekday,
          start_time: toDbTime(row.start_time),
          end_time: toDbTime(row.end_time),
        })),
      )
      if (error) throw dbError(`replace ${where} (they are now EMPTY, rerun after fixing)`, error)
    }
    if (current.length > 0) counts.working_hours.updated++
    else counts.working_hours.created++
  }

  // 9. Auth users: admin API, confirmed, no invite link (it would open a session in Safari,
  // outside the installed app). Existing users are reused as they are.
  /** @type {Map<string, string>} */
  const userIds = new Map()
  for (const member of desired.members) {
    const known = users.get(member.email)
    if (known) {
      userIds.set(member.email, known)
      counts.auth_users.unchanged++
      continue
    }
    const { data, error } = await db.auth.admin.createUser({
      email: member.email,
      email_confirm: true,
    })
    if (error) throw dbError(`create Auth user ${member.email}`, error)
    userIds.set(member.email, data.user.id)
    emailOf.set(data.user.id, member.email)
    counts.auth_users.created++
  }

  // 10. Memberships, in the order of planMemberWrites: each request commits on its own, and
  // after each one the business still has an owner (business_members_keep_owner) and no staff
  // member has two logins (business_members_staff_unique). So ownership hand-overs and staff
  // moves (also to a new login) go through, and a rerun after a failure continues from there.
  const wantedMembers = desired.members.map((member) => ({
    user_id: required(userIds, member.email, 'user'),
    role: member.role,
    staff_id: member.staff === null ? null : required(staffIds, member.staff, 'staff'),
  }))
  const members = diffMembers(state.members, wantedMembers)
  for (const write of planMemberWrites(state.members, wantedMembers)) {
    if (write.kind === 'insert') {
      const { error } = await db
        .from('business_members')
        .insert(write.rows.map((row) => ({ business_id: businessId, ...row })))
      if (error) throw dbError('add members', error)
      continue
    }
    const { error } = await db
      .from('business_members')
      .update(write.patch)
      .eq('business_id', businessId)
      .eq('user_id', write.user_id)
    if (error) throw dbError(`update member ${emailOf.get(write.user_id) ?? write.user_id}`, error)
  }
  counts.members.created = members.insert.length
  counts.members.updated = members.update.length
  counts.members.unchanged = wantedMembers.length - members.insert.length - members.update.length
  summary.notInFile.push(
    ...members.notInFile.map(
      (row) => `member ${emailOf.get(row.user_id) ?? row.user_id} (${row.role})`,
    ),
  )

  return summary
}

/**
 * Human-readable summary lines (no secrets, no client data: only staff names and staff emails).
 * @param {Summary} summary
 * @returns {string[]}
 */
export function formatSummary(summary) {
  const lines = [`  business        ${summary.business}`]
  let changes = summary.business === 'unchanged' ? 0 : 1
  for (const [name, c] of Object.entries(summary.counts)) {
    const parts = [
      c.created && `${c.created} created`,
      c.updated && `${c.updated} updated`,
      c.removed && `${c.removed} removed`,
      c.unchanged && `${c.unchanged} unchanged`,
    ].filter(Boolean)
    changes += c.created + c.updated + c.removed
    lines.push(`  ${name.padEnd(15)} ${parts.join(', ') || '-'}`)
  }
  if (summary.notInFile.length > 0) {
    lines.push('  In the database but not in the file (left as they are):')
    lines.push(...summary.notInFile.map((entry) => `    - ${entry}`))
  }
  lines.push(changes === 0 ? 'No changes.' : `${changes} change(s) written.`)
  return lines
}
