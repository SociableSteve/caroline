/**
 * Spec 13, "One check over the whole route list", slice 1's shape of it: with no session
 * mechanism yet, every request carries no valid session, so `authRequired` alone decides between
 * a 401 and letting the request through. Criteria 1, 2, 6, 8 and 31.
 */
import { describe, expect, it } from 'vitest'
import Fastify, { type HTTPMethods } from 'fastify'
import { loadConfig } from '../../src/config/load.js'
import { buildServer, registerRoutes } from '../../src/server/app.js'
import { buildJobs } from '../../src/jobs/registry.js'
import { createChangeFeed } from '../../src/server/changes.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { NO_BUILT_WEB_ROOT } from '../helpers/test-server.js'
import { EXEMPT_AUTH_ROUTES, isExemptFromSessionCheck } from '../../src/server/auth-gate.js'
import { createAuthService } from '../../src/auth/service.js'
import { createSession } from '../../src/db/repositories/sessions.js'
import { sessionCookieName } from '../../src/auth/cookie.js'

const noEnv = {} as NodeJS.ProcessEnv

/** A loopback install with no `auth` block at all: today's default, on both sides of this spec. */
function looseConfig() {
  return loadConfig({ file: null, env: noEnv })
}

/** Spec 13, criterion 31: `auth.mode: "required"` on loopback, with a provider and an allowlist. */
function strictConfig() {
  return loadConfig({
    file: {
      auth: {
        mode: 'required',
        allow: ['owner@example.com'],
        provider: { clientId: 'a-client-id' },
      },
    },
    env: noEnv,
  })
}

async function everyRegisteredRoute(): Promise<Array<{ method: HTTPMethods; url: string }>> {
  const recorded: Array<{ method: HTTPMethods; url: string }> = []
  const app = Fastify()
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) recorded.push({ method, url: route.url })
  })

  const database = migratedDatabase()
  const config = looseConfig()
  registerRoutes(app, {
    config,
    database,
    changes: createChangeFeed(),
    now: () => Date.now(),
    jobs: buildJobs({ database, config }),
    auth: createAuthService({ config, database }),
  })
  await app.ready()
  await app.close()

  return recorded
}

describe('with authentication not required (criterion 2)', () => {
  it('refuses no request for want of a session, on any registered route', async () => {
    const config = looseConfig()
    const app = await buildServer({ config, database: migratedDatabase() })

    for (const { method, url } of await everyRegisteredRoute()) {
      // The change feed hijacks the response and never ends, so it is not a request `inject`
      // can wait out; it is exercised on its own terms in `test/server/changes.test.ts`.
      if (url === '/api/changes') continue

      const path = url.replaceAll(/:\w+/g, '1')
      const response = await app.inject({ method: method as 'GET' | 'POST', url: path })
      expect(response.statusCode, `${method} ${path}`).not.toBe(401)
    }

    await app.close()
  })

  it('answers 400, naming server.publicUrl, for a request carrying X-Forwarded-For (criterion 6)', async () => {
    const config = looseConfig()
    const app = await buildServer({ config, database: migratedDatabase() })

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('server.publicUrl')

    await app.close()
  })

  /**
   * Spec 13, "Why there is no CSRF token", and spec 09 criterion 22. A body-less POST is a
   * simple request: no preflight is required of it, so the CORS preflight requirement that
   * protects every JSON-body route protects none of these, and a page anywhere could fire one at
   * a loopback install and have it succeed. The `Origin` check is the answer already written for
   * the exposed install, and there is no reason for it to be conditional on a login.
   */
  it('refuses a body-less POST carrying a cross-site Origin (criterion 22)', async () => {
    const config = looseConfig()
    const app = await buildServer({ config, database: migratedDatabase() })

    for (const url of ['/api/tasks/1/complete', '/api/jobs/classify/run']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { origin: 'https://elsewhere.example.com' },
      })

      expect(response.statusCode, url).toBe(403)
    }

    await app.close()
  })

  it('accepts a body-less POST from any loopback Origin, so the dev proxy still works', async () => {
    const config = looseConfig()
    const app = await buildServer({ config, database: migratedDatabase() })

    // `npm run dev:web` serves the client from a different loopback port than the API's, so the
    // origin a dev request carries is loopback but never the bind's own.
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs/classify/run',
      headers: { origin: 'http://localhost:5173' },
    })

    expect(response.statusCode).not.toBe(403)

    await app.close()
  })

  it('answers 400 for a request carrying Forwarded (criterion 6)', async () => {
    const config = looseConfig()
    const app = await buildServer({ config, database: migratedDatabase() })

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { forwarded: 'for=203.0.113.5' },
    })

    expect(response.statusCode).toBe(400)

    await app.close()
  })
})

describe('with authentication required (criterion 1, 31)', () => {
  it('answers 401 in the standard error shape for every registered route but the three exempt ones', async () => {
    const config = strictConfig()
    expect(config.authRequired).toBe(true)
    const app = await buildServer({ config, database: migratedDatabase() })

    for (const { method, url } of await everyRegisteredRoute()) {
      if (EXEMPT_AUTH_ROUTES.has(`${method} ${url}`)) continue

      const path = url.replaceAll(/:\w+/g, '1')
      const response = await app.inject({ method: method as 'GET' | 'POST', url: path })
      expect(response.statusCode, `${method} ${path}`).toBe(401)

      // Fastify registers HEAD for every GET automatically, and a HEAD response correctly
      // carries no body at all, so there is nothing to parse for the shape assertion below.
      if (method === 'HEAD') continue

      expect(response.json(), `${method} ${path}`).toEqual({
        error: { code: 'unauthorized', message: expect.any(String) },
      })
    }

    await app.close()
  })

  it('exempts exactly the three public auth routes and the MCP endpoint and token endpoint (spec 12)', () => {
    // The MCP endpoint and its token endpoint check their own credential rather than a session,
    // and are unregistered at all unless mcp.enabled is true and the bind is loopback (spec 12,
    // criteria 5 and 6), so this line grants nothing on an install that has not already turned it
    // on. `GET /api/mcp/authorize` and the consent routes beside it are deliberately not exempt:
    // they are hit by a browser, and the consent screen is exactly the surface a login already
    // protects where one is configured.
    expect([...EXEMPT_AUTH_ROUTES].toSorted()).toEqual(
      [
        'GET /api/auth/callback',
        'GET /api/auth/status',
        'POST /api/auth/login',
        'POST /api/mcp',
        'POST /api/mcp/token',
      ].toSorted(),
    )
  })

  it('does not read a forwarded header at all: one is answered 401, not 400', async () => {
    const config = strictConfig()
    const app = await buildServer({ config, database: migratedDatabase() })

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    })

    expect(response.statusCode).toBe(401)

    await app.close()
  })
})

describe('the SPA shell and its assets (criterion 8)', () => {
  it('are not gated, whether or not authentication is required', async () => {
    // This test's premise is that there is no shell to serve, so it needs a `webRoot` that
    // provably does not exist rather than one that happens not to on a clean checkout.
    const app = await buildServer({
      config: strictConfig(),
      database: migratedDatabase(),
      webRoot: NO_BUILT_WEB_ROOT,
    })

    const response = await app.inject({ method: 'GET', url: '/some-client-route' })

    // With no SPA to serve, this 404s rather than serving the shell. What matters here is
    // that it is not the session gate that refused it.
    expect(response.statusCode).toBe(404)

    await app.close()
  })
})

/**
 * Spec 13, "The boundary is decided by the route that matched", and spec 09 criterion 20.
 * Fastify decodes percent-escapes before it matches a route, so a request for `/%61pi/tasks`
 * reaches the `/api/tasks` handler while a check written against the raw request URL sees a path
 * that does not begin with `/api/` and lets it through with no session at all. The criterion 16
 * test above cannot catch that, because it walks the canonical route paths, and those are exactly
 * the strings the two readings agree on.
 */
describe('the session check is decided by the matched route (criterion 20)', () => {
  const encodedRequests = [
    { method: 'GET' as const, url: '/%61pi/tasks' },
    { method: 'GET' as const, url: '/%61pi/config' },
    { method: 'GET' as const, url: '/%61pi/health' },
    { method: 'POST' as const, url: '/%61pi/tasks' },
    { method: 'PATCH' as const, url: '/%61pi/settings' },
    { method: 'POST' as const, url: '/%61pi/jobs/classify/run' },
  ]

  for (const { method, url } of encodedRequests) {
    it(`answers 401 for ${method} ${url}`, async () => {
      const app = await buildServer({ config: strictConfig(), database: migratedDatabase() })

      const response = await app.inject({
        method,
        url,
        ...(method === 'GET' ? {} : { payload: {} }),
      })

      expect(response.statusCode, `${method} ${url}`).toBe(401)

      await app.close()
    })
  }

  it('refuses a request matching no route at all whose decoded path is under /api', async () => {
    const app = await buildServer({
      config: strictConfig(),
      database: migratedDatabase(),
      webRoot: NO_BUILT_WEB_ROOT,
    })

    const response = await app.inject({ method: 'GET', url: '/%61pi/no-such-route' })

    expect(response.statusCode).toBe(401)

    await app.close()
  })

  it('does not throw out of the hook for a malformed percent-escape', async () => {
    const app = await buildServer({
      config: strictConfig(),
      database: migratedDatabase(),
      webRoot: NO_BUILT_WEB_ROOT,
    })

    const response = await app.inject({ method: 'GET', url: '/%zz-not-an-escape' })

    // Fastify's own router refuses a malformed escape before any hook runs, so this is not by
    // itself proof that the gate decodes defensively; the unit assertions below are, and this
    // one records that nothing reaches the gate to be a 500 in the first place.
    expect(response.statusCode).toBe(400)

    await app.close()
  })

  /**
   * Asserted on the predicate as well as over HTTP, because the two failures it has to survive
   * cannot both be driven through the router: Fastify refuses a malformed escape itself, so
   * there is no request that reaches the hook carrying one, and a decode that threw would
   * otherwise be a 500 nothing here could produce.
   */
  it('decides on the template where one matched, and fails closed where none did', () => {
    expect(isExemptFromSessionCheck('GET', '/api/tasks', '/%61pi/tasks')).toBe(false)
    expect(isExemptFromSessionCheck('GET', '/api/auth/status', '/api/auth/status')).toBe(true)
    expect(isExemptFromSessionCheck('GET', '/*', '/some-client-route')).toBe(true)
    expect(isExemptFromSessionCheck('GET', undefined, '/%61pi/no-such-route')).toBe(false)
    expect(isExemptFromSessionCheck('GET', undefined, '/api/no-such-route?q=1')).toBe(false)
    expect(isExemptFromSessionCheck('GET', undefined, '/login')).toBe(true)
    expect(isExemptFromSessionCheck('GET', undefined, '/%zz-not-an-escape')).toBe(true)
    expect(isExemptFromSessionCheck('GET', undefined, '/api%zz')).toBe(false)
  })

  it('sets request.sessionId where the session check passed (criteria 22 and 23)', async () => {
    const database = migratedDatabase()
    const app = await buildServer({ config: strictConfig(), database })
    const session = createSession(database, Date.now())

    let seen: string | null | undefined
    app.addHook('preHandler', async (request) => {
      seen = request.sessionId
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: `${sessionCookieName(false)}=${session.value}` },
    })

    expect(response.statusCode).toBe(200)
    expect(seen).toBe(session.id)

    await app.close()
  })
})
