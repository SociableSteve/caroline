import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
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
