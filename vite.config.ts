import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'

const PRO_APP_PREFIX = '/app'

/**
 * Two HTML entries (ADR-0002): the booking page (`index.html`) and the pro app (`app/index.html`).
 * In dev/preview, every `/app/*` route without a file extension is served the pro app shell.
 */
function isProAppRoute(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  const isUnderPrefix = path === PRO_APP_PREFIX || path.startsWith(`${PRO_APP_PREFIX}/`)
  const lastSegment = path.split('/').pop() ?? ''
  return isUnderPrefix && !lastSegment.includes('.')
}

const proAppFallback: Connect.NextHandleFunction = (req, _res, next) => {
  if (req.url && isProAppRoute(req.url)) req.url = `${PRO_APP_PREFIX}/index.html`
  next()
}

function proAppShell(): Plugin {
  return {
    name: 'anaklo:pro-app-shell',
    configureServer(server) {
      server.middlewares.use(proAppFallback)
    },
    configurePreviewServer(server) {
      server.middlewares.use(proAppFallback)
    },
  }
}

/**
 * Every VITE_* value ends up in the public bundle. Refuse to build if one of them is a server
 * key (ADR-0005). Complements scripts/check-secrets.mjs, which scans the output after the build.
 */
function assertNoServerKeys(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    if (/sb_secret_/.test(value)) throw new Error(`${name} contains a Supabase secret key`)
    const payload = /^eyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]+$/.exec(value)?.[1]
    if (payload && Buffer.from(payload, 'base64url').toString('utf8').includes('"service_role"')) {
      throw new Error(`${name} contains a service_role JWT`)
    }
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  if (command === 'build') assertNoServerKeys(env)
  const supabaseUrl = env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321'

  // Same-origin `/api/*` proxy to Supabase (ADR-0005/0006). The key is anchored with a trailing
  // slash so a booking slug that merely starts with "api" (e.g. /api-barber) is not proxied.
  // Production hosting must use the same rule: `/api/:path*`, not `/api*`.
  const apiProxy = {
    '^/api/': {
      target: supabaseUrl,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api(?=\/)/, ''),
    },
  }

  return {
    plugins: [react(), proAppShell()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@fn-shared': fileURLToPath(new URL('./supabase/functions/_shared', import.meta.url)),
      },
    },
    server: { port: 5173, strictPort: true, proxy: apiProxy },
    preview: { port: 4173, strictPort: true, proxy: apiProxy },
    build: {
      target: 'es2022',
      manifest: true,
      sourcemap: true,
      rolldownOptions: {
        input: {
          booking: fileURLToPath(new URL('./index.html', import.meta.url)),
          pro: fileURLToPath(new URL('./app/index.html', import.meta.url)),
        },
      },
    },
  }
})
