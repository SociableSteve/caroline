import { join } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { WEB_BUILD_DIR } from './src/server/web-build-dir.js'

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: {
    // Relative to `root` above, not the repo root, so this climbs back out of `web/` before
    // going down into `WEB_BUILD_DIR` (shared with `resolveWebRoot` in `src/server/app.ts`,
    // so the two cannot drift apart silently).
    outDir: join('..', ...WEB_BUILD_DIR),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // A regular expression, not a prefix: the string '/api' also matches '/api.ts', so the
      // client's own api module was being proxied to Fastify and coming back as a JSON 404,
      // which a browser will not execute as a module. Every route is under '/api/', so
      // requiring the slash separates the API from any file whose name starts with "api".
      '^/api/': 'http://127.0.0.1:5123',
    },
  },
})
