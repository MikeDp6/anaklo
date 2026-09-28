import { expect } from '@playwright/test'
import { z } from 'zod/mini'

/**
 * The local Supabase stack's Mailpit (Auth sends the sign-in code there). API:
 * https://mailpit.axllent.org/docs/api-v1/
 */
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324'

const MessageList = z.object({
  messages: z.array(
    z.object({
      ID: z.string(),
      To: z.nullable(z.array(z.object({ Address: z.string() }))),
    }),
  ),
})
const Message = z.object({ Text: z.string() })

async function mailpit(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${MAILPIT_URL}/api/v1${path}`, init)
  if (!response.ok) throw new Error(`Mailpit ${init?.method ?? 'GET'} ${path}: ${response.status}`)
  return response
}

/** IDs of the messages sent to exactly this address, newest first. */
async function messageIdsTo(email: string): Promise<string[]> {
  const query = encodeURIComponent(`to:"${email}"`)
  const response = await mailpit(`/search?query=${query}&limit=50`)
  const { messages } = MessageList.parse(await response.json())
  return messages
    .filter((message) => message.To?.some((to) => to.Address.toLowerCase() === email.toLowerCase()))
    .map((message) => message.ID)
}

/** Empties the mailbox of one address, so the next code read is the new one. */
export async function deleteMessagesTo(email: string): Promise<void> {
  const ids = await messageIdsTo(email)
  // Never send an empty list: Mailpit then deletes EVERY message (other tests' codes too).
  if (ids.length === 0) return
  await mailpit('/messages', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: ids }),
  })
}

/** The 6-digit code of the newest message to this address, or null if none arrived yet. */
export async function findLoginCode(email: string): Promise<string | null> {
  const [newest] = await messageIdsTo(email)
  if (!newest) return null
  const response = await mailpit(`/message/${newest}`)
  const { Text } = Message.parse(await response.json())
  return /\b(\d{6})\b/.exec(Text)?.[1] ?? null
}

export async function waitForLoginCode(email: string): Promise<string> {
  await expect
    .poll(() => findLoginCode(email), {
      message: `a sign-in code for ${email} in Mailpit`,
      timeout: 20_000,
    })
    .not.toBeNull()
  const code = await findLoginCode(email)
  if (!code) throw new Error(`no sign-in code for ${email}`)
  return code
}

/** How many messages this address has (the unknown-email test expects none). */
export async function countMessagesTo(email: string): Promise<number> {
  return (await messageIdsTo(email)).length
}
