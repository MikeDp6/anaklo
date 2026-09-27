// Fails if a server-side key ever reaches the frontend build (ADR-0005).
// Looks for secret API keys and JWTs whose payload claims the service_role.
// Also fails if a bundle points browsers at its source map (maps are 'hidden', for Sentry only).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
const SECRET_KEY = /sb_secret_[\w-]{8,}/
const JWT = /eyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]+/g
const SOURCE_MAP_LINK = /[#@]\s*sourceMappingURL=/

/**
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (/\.(js|html|css|json|webmanifest|map)$/.test(name)) yield path
  }
}

/** @type {string[]} */
const problems = []
for (const file of walk(DIST)) {
  const text = readFileSync(file, 'utf8')
  if (SECRET_KEY.test(text)) problems.push(`${file}: contains an sb_secret_ key`)
  if (/\.(js|css)$/.test(file) && SOURCE_MAP_LINK.test(text)) {
    problems.push(`${file}: links its source map (use build.sourcemap = 'hidden')`)
  }
  for (const match of text.matchAll(JWT)) {
    try {
      const segment = match[1]
      if (!segment) continue
      const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
      if (payload.role === 'service_role') problems.push(`${file}: contains a service_role JWT`)
    } catch {
      // not a JWT payload; ignore
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('No server-side keys or source map links in the build.')
