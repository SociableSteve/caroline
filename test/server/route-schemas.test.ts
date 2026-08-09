/**
 * Spec 08 criterion 1, as a property of the whole API rather than of one route: every route
 * under `/api` declares a schema. A route added later without one fails this, which is the
 * point. Validation is not something to remember per route.
 */
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { registerRoutes } from '../../src/server/app.js'
import { REQUEST_TIME, testConfig } from '../helpers/test-server.js'
import { createChangeFeed } from '../../src/server/changes.js'
import { migratedDatabase } from '../helpers/temp-database.js'

interface RecordedRoute {
  readonly method: string
  readonly url: string
  readonly schema: unknown
}

/**
 * `onRoute` is the only view Fastify offers of what was registered, and it has to be
 * installed before the routes are. `registerRoutes` is the whole list, so a bare instance
 * plus the hook sees everything the real server serves.
 */
async function registeredRoutes(): Promise<RecordedRoute[]> {
  const recorded: RecordedRoute[] = []
  const app = Fastify()
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      recorded.push({ method, url: route.url, schema: route.schema })
    }
  })

  registerRoutes(app, {
    config: testConfig,
    database: migratedDatabase(),
    changes: createChangeFeed(),
    now: () => REQUEST_TIME,
  })
  await app.ready()
  await app.close()

  return recorded
}

describe('every API route', () => {
  it('declares a schema', async () => {
    const routes = await registeredRoutes()

    const undeclared = routes
      .filter((route) => route.url.startsWith('/api'))
      .filter((route) => route.schema === undefined)
      .map((route) => `${route.method} ${route.url}`)

    expect(undeclared).toEqual([])
  })

  it('is registered under /api, since the API is the only thing routed here', async () => {
    const routes = await registeredRoutes()

    expect(routes.every((route) => route.url.startsWith('/api'))).toBe(true)
  })

  it('covers the routes M2 promises, so the list above cannot pass by being empty', async () => {
    const routes = (await registeredRoutes()).map((route) => `${route.method} ${route.url}`)

    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /api/health',
        'GET /api/config',
        'GET /api/changes',
        'GET /api/tasks',
        'POST /api/tasks',
        'POST /api/tasks/bulk',
        'PATCH /api/tasks/:id',
        'DELETE /api/tasks/:id',
        'POST /api/tasks/:id/complete',
        'POST /api/tasks/:id/tracking',
        'GET /api/projects',
        'POST /api/projects',
        'GET /api/projects/:id',
        'PATCH /api/projects/:id',
        'DELETE /api/projects/:id',
      ]),
    )
  })
})
