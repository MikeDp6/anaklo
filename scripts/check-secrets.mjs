// Fails if a server-side key ever reaches the frontend build (ADR-0005): Supabase secret keys,
// service_role JWTs and OneSignal REST/Organization API keys (scripts/lib/server-keys.mjs).
// Also fails if a bundle points browsers at its source map (maps are 'hidden', for Sentry only).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findServerKeys } from './lib/server-keys.mjs'

const DIST = 'dist'
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
  for (const key of findServerKeys(text)) problems.push(`${file}: contains ${key}`)
  if (/\.(js|css)$/.test(file) && SOURCE_MAP_LINK.test(text)) {
    problems.push(`${file}: links its source map (use build.sourcemap = 'hidden')`)
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('No server-side keys or source map links in the build.')
