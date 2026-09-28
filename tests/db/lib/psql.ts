import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../../scripts/lib/cli.mjs'

/**
 * A psql session inside the LOCAL stack's database container (`docker exec`, never a network
 * address), for lock-order tests that need a transaction held open between steps, which
 * PostgREST (one transaction per request) cannot do. Runs as postgres, like pgTAP, so it can call
 * the private `_impl` functions directly.
 *
 * No psql meta-commands: a statement is followed by `select '<marker>'`, and a step is done when
 * its marker or an error shows up.
 */

/** `supabase_db_<project_id>` of supabase/config.toml: the container `npm run db:start` runs. */
function dbContainer(): string {
  const config = readFileSync(path.join(REPO_ROOT, 'supabase', 'config.toml'), 'utf8')
  const id = /^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m.exec(config)?.[1]
  if (!id) throw new Error('project_id not found in supabase/config.toml')
  return `supabase_db_${id}`
}

/** A SQL string literal. */
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export class PsqlSession {
  readonly #child: ChildProcessWithoutNullStreams
  #output = ''
  #closed = false
  #listeners: Array<() => void> = []

  constructor() {
    this.#child = spawn(
      'docker',
      [
        'exec',
        '-i',
        dbContainer(),
        'psql',
        '-X',
        '-q',
        '-A',
        '-t',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const append = (chunk: Buffer) => {
      this.#output += chunk.toString('utf8')
      this.#notify()
    }
    this.#child.stdout.on('data', append)
    this.#child.stderr.on('data', append)
    this.#child.on('close', () => {
      this.#closed = true
      this.#notify()
    })
    this.#child.on('error', (error) => {
      this.#output += `ERROR: could not start docker (${error.message})\n`
      this.#closed = true
      this.#notify()
    })
  }

  #notify(): void {
    for (const listener of this.#listeners.splice(0)) listener()
  }

  /** Everything the session printed so far (results and errors). */
  get output(): string {
    return this.#output
  }

  /**
   * Sends statements and waits up to `ms` for them to finish. Returns what they printed, or null
   * when they are still running (e.g. waiting on a lock) when the time is up.
   */
  async query(sql: string, ms = 10_000): Promise<string | null> {
    const marker = `done-${randomUUID()}`
    const from = this.#output.length
    this.#child.stdin.write(`${sql}\nselect ${literal(marker)};\n`)
    return this.#waitFor(from, marker, ms)
  }

  /** Waits for statements sent earlier with `send` (same rules as `query`). */
  async #waitFor(from: number, marker: string, ms: number): Promise<string | null> {
    const deadline = Date.now() + ms
    for (;;) {
      const printed = this.#output.slice(from)
      if (printed.includes(marker) || printed.includes('ERROR:') || this.#closed) {
        return printed.replace(`${marker}\n`, '')
      }
      const left = deadline - Date.now()
      if (left <= 0) return null
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.#listeners.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** Sends statements without waiting; `settle` later returns what they printed. */
  send(sql: string): { settle: (ms?: number) => Promise<string | null> } {
    const marker = `done-${randomUUID()}`
    const from = this.#output.length
    this.#child.stdin.write(`${sql}\nselect ${literal(marker)};\n`)
    return { settle: (ms = 10_000) => this.#waitFor(from, marker, ms) }
  }

  /** Ends the session; an open transaction is rolled back by the server. */
  async close(): Promise<void> {
    if (this.#closed) return
    const closed = new Promise<void>((resolve) => this.#child.once('close', () => resolve()))
    this.#child.stdin.end('rollback;\n')
    await closed
  }
}

/**
 * Waits until another backend is waiting on a lock while running a statement that contains
 * `fragment` (pg_stat_activity), so a test knows a step really blocked where it meant it to.
 */
export async function waitForLockWait(
  probe: PsqlSession,
  fragment: string,
  ms = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const found = await probe.query(
      `select count(*) from pg_stat_activity
       where wait_event_type = 'Lock' and pid <> pg_backend_pid()
         and position(${literal(fragment)} in query) > 0;`,
    )
    if (found !== null && Number.parseInt(found.trim(), 10) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}
