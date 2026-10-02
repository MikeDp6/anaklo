import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test as setup } from '@playwright/test'
import { aal2State, resetFactors } from '../lib/auth'
import { engineOf, ownerStatePath, setupOwnerEmail } from '../lib/authPaths'

// Setup project of each engine (contract 1.7 §7.4): its seed owner (`owner-setup-<engine>`,
// owner of demo-barber without a staff row) starts from no device at all on every run (reruns
// without db:reset, CI retries), enrols one through the API (grant, enrol, verify) and leaves an
// `aal2` storageState for the specs with `member: 'owner'`. Through the API only: the enrolment
// screens have their own spec (mfa-enroll.spec.ts).

// Playwright passes the fixtures first; this one needs none.
// eslint-disable-next-line no-empty-pattern
setup('the engine’s owner gets an aal2 session', async ({}, testInfo) => {
  setup.setTimeout(120_000)
  const engine = engineOf(testInfo.project.name)
  const email = setupOwnerEmail(engine)
  // Deletes the factors of an earlier run the way the Nous reset does (grants and audit first),
  // and revokes every session of that run.
  await resetFactors(email)
  const state = await aal2State(email, { fresh: true })
  const file = ownerStatePath(engine)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state), 'utf8')
})
