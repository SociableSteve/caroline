/**
 * The dev server's proxy rule, which is not covered by anything else and broke the client
 * once already: as the prefix string `/api`, it matched `/api.ts` as well as `/api/tasks`, so
 * the browser's request for the client's own api module was proxied to Fastify and came back
 * as a JSON 404. A browser will not execute that as a module, and the app failed to load with
 * a MIME type error rather than anything pointing at the proxy.
 *
 * Vite treats a key beginning with `^` as a regular expression, which is what the config uses,
 * so this asserts the rule the way Vite applies it.
 */
import { describe, expect, it } from 'vitest'
import config from '../vite.config.js'

const proxy = config.server?.proxy ?? {}
const patterns = Object.keys(proxy)

describe('the dev server proxy', () => {
  it('has exactly one rule, expressed as a regular expression', () => {
    expect(patterns).toHaveLength(1)
    expect(patterns[0]?.startsWith('^')).toBe(true)
  })

  it('proxies the API routes', () => {
    const pattern = new RegExp(patterns[0] ?? '')

    for (const url of ['/api/tasks', '/api/tasks/task-1/complete', '/api/health', '/api/changes']) {
      expect(pattern.test(url)).toBe(true)
    }
  })

  it('leaves a client module whose name begins with "api" to Vite', () => {
    const pattern = new RegExp(patterns[0] ?? '')

    for (const url of ['/api.ts', '/api.js', '/apiary.ts', '/main.tsx']) {
      expect(pattern.test(url)).toBe(false)
    }
  })
})
