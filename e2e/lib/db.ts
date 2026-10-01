import { expect } from '@playwright/test'
import { z } from 'zod/mini'
import { literal, PsqlSession } from '../../tests/db/lib/psql'

/**
 * Reads of the LOCAL database for the messaging e2e (contract 1.5 §5.6): the `docker exec` psql
 * session of tests/db/lib/psql.ts (the stack's own container, never a network address), as
 * postgres, read-only, one statement at a time (autocommit: every read sees the latest commit).
 * What the fake SMS adapter and the fake push sender "sent" is visible only here: a row of
 * `messages_log` with `status 'sent'` and `provider 'fake'`.
 */

const MessageRow = z.object({
  id: z.string(),
  channel: z.enum(['sms', 'push']),
  template: z.string(),
  status: z.string(),
  provider: z.nullable(z.string()),
  provider_message_id: z.nullable(z.string()),
  recipient_user_id: z.nullable(z.string()),
  error: z.nullable(z.string()),
})
export type MessageRow = z.infer<typeof MessageRow>

let session: PsqlSession | null = null

function db(): PsqlSession {
  session ??= new PsqlSession()
  return session
}

/** Ends this worker's psql session (call it from `test.afterAll`). */
export async function closeDb(): Promise<void> {
  const open = session
  session = null
  await open?.close()
}

/** One JSON value selected by `sql` (a single row, single column). */
async function selectJson(sql: string): Promise<unknown> {
  const printed = await db().query(sql, 10_000)
  if (printed === null) throw new Error('psql did not answer within 10″')
  if (printed.includes('ERROR:')) throw new Error(`psql: ${printed}`)
  const line = printed
    .split('\n')
    .map((text) => text.trim())
    .find((text) => /^[[{"]/.test(text) || text === 'null')
  if (line === undefined) throw new Error(`psql printed no JSON: ${printed}`)
  return JSON.parse(line) as unknown
}

/** Every `messages_log` row of an appointment, oldest first. */
export async function messagesOf(appointmentId: string): Promise<MessageRow[]> {
  const rows = await selectJson(
    `select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at, m.id), '[]'::jsonb)
       from (select id, channel, template, status, provider, provider_message_id,
                    recipient_user_id, error, created_at
               from public.messages_log
              where appointment_id = ${literal(appointmentId)}::uuid) m;`,
  )
  return z.array(MessageRow).parse(rows)
}

/**
 * Polls (≤ 15″) until the appointment has a row of `template` that satisfies `done` (by default:
 * `sent`), then returns it; for push, `recipient` picks the row of that user.
 */
export async function waitForMessage(
  appointmentId: string,
  template: string,
  options: { recipient?: string; done?: (row: MessageRow) => boolean; ms?: number } = {},
): Promise<MessageRow> {
  const done = options.done ?? ((row: MessageRow) => row.status === 'sent')
  let found: MessageRow | undefined
  await expect
    .poll(
      async () => {
        const rows = await messagesOf(appointmentId)
        found = rows.find(
          (row) =>
            row.template === template &&
            (options.recipient === undefined || row.recipient_user_id === options.recipient),
        )
        return found ? { template: found.template, status: found.status, done: done(found) } : null
      },
      { timeout: options.ms ?? 15_000, message: `${template} of ${appointmentId}` },
    )
    .toMatchObject({ done: true })
  if (!found) throw new Error(`no ${template} row`)
  return found
}

/** The active appointment of a staff member at an instant (set up through the pro UI). */
export async function appointmentAt(staffId: string, startsAt: string): Promise<string> {
  const id = await selectJson(
    `select coalesce((select to_json(a.id) from public.appointments a
                       where a.staff_id = ${literal(staffId)}::uuid
                         and a.starts_at = ${literal(startsAt)}::timestamptz
                         and a.status in ('booked', 'confirmed')
                       limit 1), 'null'::json);`,
  )
  if (typeof id !== 'string') throw new Error(`no active appointment at ${startsAt}`)
  return id
}
