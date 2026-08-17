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
import { EXEMPT_AUTH_ROUTES } from '../../src/server/auth-gate.js'
import { createAuthService } from '../../src/auth/service.js'

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

  it('exempts exactly the three public auth routes and the MCP endpoint (spec 12)', () => {
    // The MCP endpoint checks its own credential rather than a session, and is unregistered at
    // all unless mcp.enabled is true and the bind is loopback (spec 12, criteria 5 and 6), so
    // this line grants nothing on an install that has not already turned it on.
    expect([...EXEMPT_AUTH_ROUTES].toSorted()).toEqual(
      [
        'GET /api/auth/callback',
        'GET /api/auth/status',
        'POST /api/auth/login',
        'POST /api/mcp',
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
    const app = await buildServer({ config: strictConfig(), database: migratedDatabase() })

    const response = await app.inject({ method: 'GET', url: '/some-client-route' })

    // The built SPA is absent in this checkout, so this 404s rather than serving the shell.
    // What matters here is that it is not the session gate that refused it.
    expect(response.statusCode).not.toBe(401)

    await app.close()
  })
})
