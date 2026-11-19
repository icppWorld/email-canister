import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

import { applyToHtml, checkSettings, loadBrand, TYPES } from './brand/brand.mjs'

// The build is generic: a deployment adds its settings with brand/brand.mjs.
// Only the dev server applies them itself, from WEBMAIL_BACKEND, WEBMAIL_NETWORK,
// WEBMAIL_ORIGIN and WEBMAIL_BRAND (a brand folder, relative to webmail/), set
// in the shell or in webmail/.env.local.
function devSettings(env: Record<string, string>): Plugin {
  let state: {
    loaded: ReturnType<typeof loadBrand>
    settings: ReturnType<typeof checkSettings>
  } | null = null
  return {
    name: 'dev-settings',
    apply: 'serve',
    configureServer(server) {
      state = {
        loaded: loadBrand(env.WEBMAIL_BRAND || undefined),
        settings: checkSettings({
          backend: env.WEBMAIL_BACKEND,
          network: env.WEBMAIL_NETWORK || 'local',
          origin: env.WEBMAIL_ORIGIN || undefined,
        }),
      }
      const outputs = state.loaded.outputs
      server.middlewares.use((request, response, next) => {
        const file = (request.url ?? '').split('?')[0].slice(1)
        const content = outputs.get(file)
        if (content === undefined) return next()
        response.setHeader(
          'Content-Type',
          TYPES[path.extname(file).toLowerCase()] ?? 'text/css'
        )
        response.end(content)
      })
    },
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        state ? applyToHtml(html, state.loaded, state.settings) : html,
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), devSettings(loadEnv(mode, process.cwd(), 'WEBMAIL_'))],
  build: { chunkSizeWarningLimit: 1500 },
}))
