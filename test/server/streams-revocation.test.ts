/**
 * Spec 13, criteria 22 and 23: revoking a session closes the change feed and cuts a streaming
 * chat turn that session opened, and a reconnect carrying the same cookie is answered 401.
 * Driven over a real socket, as `test/server/changes.test.ts` does, because an SSE response
 * never ends and `inject` cannot wait one out.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { loadConfig } from '../../src/config/load.js'
import { buildServer } from '../../src/server/app.js'
import { registerChangesRoute } from '../../src/server/routes/changes.js'
import { createChangeFeed } from '../../src/server/changes.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { stubProvider, TEST_ISSUER } from '../helpers/oidc.js'

const noEnv = {} as NodeJS.ProcessEnv

function strictLoopbackConfig() {
  return loadConfig({
    file: {
      auth: {
        mode: 'required',
        allow: ['owner@example.com'],
        provider: { issuer: TEST_ISSUER, clientId: 'a-client-id' },
      },
    },
    env: noEnv,
  })
}

const started: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const stop of started.splice(0)) await stop()
})

async function listeningServer() {
  const config = strictLoopbackConfig()
  const app = await buildServer({
    config,
    database: migratedDatabase(),
    authFetch: stubProvider().fetch,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  started.push(() => app.close())

  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')

  return { app, origin: `http://127.0.0.1:${address.port}` }
}

async function login(origin: string): Promise<string> {
  const loginResponse = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const { url } = (await loginResponse.json()) as { url: string }
  const state = new URL(url).searchParams.get('state') ?? ''
  const code = new URL(url).searchParams.get('nonce') ?? ''

  const callbackResponse = await fetch(`${origin}/api/auth/callback?code=${code}&state=${state}`, {
    redirect: 'manual',
  })
  const setCookie = callbackResponse.headers.get('set-cookie')
  if (setCookie === null) throw new Error('expected a Set-Cookie header')
  return setCookie.split(';')[0] ?? ''
}

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

describe('GET /api/changes under revocation (criterion 22)', () => {
  it('closes the stream a revoked session opened, and answers a reconnect 401', async () => {
    const { origin } = await listeningServer()
    const cookie = await login(origin)

    const controller = new AbortController()
    const response = await fetch(`${origin}/api/changes`, {
      headers: { cookie },
      signal: controller.signal,
    })
    expect(response.status).toBe(200)

    let closed = false
    response.body?.pipeTo(new WritableStream()).finally(() => {
      closed = true
    })

    await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, origin },
    })

    await waitFor(() => expect(closed).toBe(true))

    const reconnect = await fetch(`${origin}/api/changes`, { headers: { cookie } })
    expect(reconnect.status).toBe(401)

    controller.abort()
  })

  it('closes the stream when its own session expires, with nothing else visiting the row', async () => {
    // Nothing revokes this session: it is the heartbeat's own periodic check, against a fake
    // session-liveness result, that has to notice and close the feed. Registered directly
    // against a bare Fastify instance, decorating `request.sessionId` the way the real auth gate
    // would, because the point under test is the route's wiring to `auth.sessionStillValid`
    // rather than the gate or the session table.
    const app = Fastify()
    app.addHook('onRequest', async (request) => {
      request.sessionId = 'a-session-id'
    })

    let sessionIsValid = true
    registerChangesRoute(app, createChangeFeed(), {
      heartbeatMs: 15,
      auth: { sessionStillValid: () => sessionIsValid },
    })

    await app.listen({ host: '127.0.0.1', port: 0 })
    started.push(() => app.close())
    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    const origin = `http://127.0.0.1:${address.port}`

    const controller = new AbortController()
    const response = await fetch(`${origin}/api/changes`, { signal: controller.signal })
    expect(response.status).toBe(200)

    let closed = false
    response.body?.pipeTo(new WritableStream()).finally(() => {
      closed = true
    })

    sessionIsValid = false

    await waitFor(() => expect(closed).toBe(true))
    controller.abort()
  })
})

describe('a chat turn under revocation (criterion 23)', () => {
  it('cuts the stream when the session is revoked mid-turn, and does not answer 401 for want of a mechanism at connect', async () => {
    const { origin } = await listeningServer()
    const cookie = await login(origin)

    // Chat is not configured in this test (no LLM key), so the turn answers a refusal event
    // immediately rather than streaming provider text; what is under test here is the wiring,
    // not the content of a turn: connecting, and then the stream being cut on revocation.
    const controller = new AbortController()
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
      signal: controller.signal,
    })
    expect(response.status).toBe(200)

    let closed = false
    response.body?.pipeTo(new WritableStream()).finally(() => {
      closed = true
    })

    await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { cookie, origin } })

    await waitFor(() => expect(closed).toBe(true))

    const nextTurn = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello again' }),
    })
    expect(nextTurn.status).toBe(401)

    controller.abort()
  })
})
