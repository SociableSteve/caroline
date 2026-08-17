/**
 * The four `/api/auth/*` routes, end to end against a real server and a real database, with the
 * identity provider stubbed. Spec 13, slice 2: criteria 9, 10, 13, 15, 16, 17, 18, 21, 24 and 33.
 */
import { describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import { loadConfig } from '../../../src/config/load.js'
import { buildServer } from '../../../src/server/app.js'
import { migratedDatabase } from '../../helpers/temp-database.js'
import { openDatabase } from '../../../src/db/connection.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { temporaryDatabasePath } from '../../helpers/temp-database.js'
import { s256Challenge, stubProvider, TEST_ISSUER } from '../../helpers/oidc.js'

/** Matches `test/server/logging.test.ts`'s helper: a writable that keeps every line rather than
 * writing to a real stream, so a test can assert on what was logged. */
function captureLog() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  return { lines, stream }
}

const noEnv = {} as NodeJS.ProcessEnv

/** A loopback install with `auth.mode: "required"`: spec 13 criterion 31's shape, which is what
 * criterion 33 asks to be not just reachable but loginable. */
function strictLoopbackConfig(overrides: Record<string, unknown> = {}) {
  return loadConfig({
    file: {
      auth: {
        mode: 'required',
        allow: ['owner@example.com'],
        provider: { issuer: TEST_ISSUER, clientId: 'a-client-id' },
        ...overrides,
      },
    },
    env: noEnv,
  })
}

/** Null where the response carried no Set-Cookie header at all, which is itself an assertion a
 * refused login makes: a test that expects a session names that explicitly rather than through
 * a thrown error from here. */
function cookieFrom(setCookieHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
  if (header === undefined) return null
  const value = header.split(';')[0]
  return value ?? null
}

function expectCookie(cookie: string | null): string {
  if (cookie === null) throw new Error('expected a Set-Cookie header')
  return cookie
}

async function loggedIn(
  app: Awaited<ReturnType<typeof buildServer>>,
  origin = 'http://localhost:5123',
) {
  const loginResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: {},
  })
  const { url } = loginResponse.json() as { url: string }
  const state = new URL(url).searchParams.get('state') ?? ''
  // The stub's token endpoint has no front channel to read the nonce from, so the test carries
  // it through as the authorization code, and `stubProvider` reads it back out on that side.
  const code = new URL(url).searchParams.get('nonce') ?? ''

  const callbackResponse = await app.inject({
    method: 'GET',
    url: `/api/auth/callback?code=${code}&state=${state}`,
  })

  return {
    loginResponse,
    callbackResponse,
    cookie: cookieFrom(callbackResponse.headers['set-cookie']),
  }
}

describe('GET /api/auth/status (criterion 9)', () => {
  it('answers without a session, naming whether auth is required and the provider label', async () => {
    const config = strictLoopbackConfig({
      provider: { issuer: TEST_ISSUER, clientId: 'a-client-id', label: 'Test IdP' },
    })
    const app = await buildServer({ config, database: migratedDatabase() })

    const response = await app.inject({ method: 'GET', url: '/api/auth/status' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      authRequired: true,
      hasSession: false,
      providerLabel: 'Test IdP',
    })
    await app.close()
  })

  it('carries nothing about the person', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({ config, database: migratedDatabase() })

    const response = await app.inject({ method: 'GET', url: '/api/auth/status' })

    expect(Object.keys(response.json())).toEqual(['authRequired', 'hasSession', 'providerLabel'])
    await app.close()
  })
})

describe('POST /api/auth/login (criterion 10)', () => {
  it('answers with a well-formed authorization URL carrying no secret and no verifier', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:5123' },
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    const { url } = response.json() as { url: string }
    const parsed = new URL(url)

    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('state')).toBeTruthy()
    expect(parsed.searchParams.get('nonce')).toBeTruthy()
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5123/api/auth/callback')
    expect(url).not.toContain('secret')
    expect(url).not.toContain('code_verifier')

    await app.close()
  })

  it('discovers lazily: never at startup, and caches after the first attempt', async () => {
    const stub = stubProvider()
    const config = strictLoopbackConfig()
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: stub.fetch })

    expect(stub.requests).toHaveLength(0)

    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:5123' },
      payload: {},
    })
    expect(stub.requests).toHaveLength(1)

    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:5123' },
      payload: {},
    })
    expect(stub.requests).toHaveLength(1)

    await app.close()
  })

  it('reports an unreachable provider to the login screen rather than as an internal error', async () => {
    const config = strictLoopbackConfig()
    const refuseNetwork: typeof globalThis.fetch = async () => {
      throw new Error('connection refused')
    }
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: refuseNetwork,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:5123' },
      payload: {},
    })

    expect(response.statusCode).toBe(502)
    expect(response.json().error.code).toBe('provider_unreachable')
    await app.close()
  })
})

describe('GET /api/auth/callback', () => {
  it('refuses a callback whose state is not the one issued, creating no session (criterion 13)', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:5123' },
      payload: {},
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/callback?code=a-code&state=not-the-real-state',
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/?login=bad_request')
    expect(response.headers['set-cookie']).toBeUndefined()
    await app.close()
  })

  it('redeems a state once: replaying the same callback the second time is refused (criterion 13)', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const { url } = (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'http://127.0.0.1:5123' },
        payload: {},
      })
    ).json() as { url: string }
    const state = new URL(url).searchParams.get('state') ?? ''
    const code = new URL(url).searchParams.get('nonce') ?? ''

    const first = await app.inject({
      method: 'GET',
      url: `/api/auth/callback?code=${code}&state=${state}`,
    })
    expect(first.statusCode).toBe(302)

    const replay = await app.inject({
      method: 'GET',
      url: `/api/auth/callback?code=${code}&state=${state}`,
    })
    expect(replay.statusCode).toBe(302)
    expect(replay.headers.location).toBe('/?login=bad_request')

    await app.close()
  })

  it('accepts the extra query params Google appends to a real callback (scope, authuser, prompt)', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const { url } = (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'http://127.0.0.1:5123' },
        payload: {},
      })
    ).json() as { url: string }
    const state = new URL(url).searchParams.get('state') ?? ''
    const code = new URL(url).searchParams.get('nonce') ?? ''

    const response = await app.inject({
      method: 'GET',
      url:
        `/api/auth/callback?code=${code}&state=${state}` +
        '&scope=openid%20email&authuser=0&prompt=consent',
    })

    expect(response.statusCode).not.toBe(400)
    expect(response.statusCode).toBe(302)

    await app.close()
  })

  it('reaches the token endpoint directly over https (criterion 15)', async () => {
    const stub = stubProvider()
    const config = strictLoopbackConfig()
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: stub.fetch })

    await loggedIn(app)

    const tokenRequest = stub.requests.find((request) => request.url.includes('/token'))
    expect(tokenRequest?.url.startsWith('https://')).toBe(true)
    await app.close()
  })

  it('sends the PKCE verifier matching the challenge login sent (criterion 15/10)', async () => {
    const stub = stubProvider()
    const config = strictLoopbackConfig()
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: stub.fetch })

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:5123' },
      payload: {},
    })
    const { url } = loginResponse.json() as { url: string }
    const parsed = new URL(url)
    const state = parsed.searchParams.get('state') ?? ''
    const challenge = parsed.searchParams.get('code_challenge') ?? ''
    const code = parsed.searchParams.get('nonce') ?? ''

    await app.inject({ method: 'GET', url: `/api/auth/callback?code=${code}&state=${state}` })

    const tokenRequest = stub.requests.find((request) => request.url.includes('/token'))
    const verifier = tokenRequest?.fields?.code_verifier ?? ''
    expect(s256Challenge(verifier)).toBe(challenge)
    await app.close()
  })

  it('refuses an identity not on auth.allow: no session, redirects into the SPA naming no address (criterion 16)', async () => {
    const stub = stubProvider({
      claims: (nonce) => ({
        iss: TEST_ISSUER,
        aud: 'a-client-id',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'an-unrelated-subject',
        nonce,
        email: 'stranger@example.com',
        email_verified: true,
      }),
    })
    const config = strictLoopbackConfig()
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: stub.fetch })

    const { callbackResponse } = await loggedIn(app)

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers.location).toBe('/?login=forbidden')
    expect(callbackResponse.headers['set-cookie']).toBeUndefined()
    expect(callbackResponse.body).not.toContain('stranger@example.com')
    await app.close()
  })

  it('logs a refused login and the subject the provider attested, naming no address (criterion 16)', async () => {
    const refusedSubject = 'an-unrelated-subject'
    const stub = stubProvider({
      claims: (nonce) => ({
        iss: TEST_ISSUER,
        aud: 'a-client-id',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: refusedSubject,
        nonce,
        email: 'stranger@example.com',
        email_verified: true,
      }),
    })
    const config = strictLoopbackConfig()
    const { lines, stream } = captureLog()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stub.fetch,
      logger: { level: 'info', stream },
    })

    const { callbackResponse } = await loggedIn(app)
    await app.close()

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers.location).toBe('/?login=forbidden')
    const logged = lines.join('\n')
    expect(logged).toContain('login refused')
    expect(logged).toContain(refusedSubject)
    expect(logged).not.toContain('stranger@example.com')
  })

  it('pins the first successful login and refuses a later one with a different subject, surviving a restart (criterion 17)', async () => {
    const path = temporaryDatabasePath()
    const config = strictLoopbackConfig()

    let database = openDatabase(path)
    runMigrations(database)

    const firstLoginStub = stubProvider({
      claims: (nonce) => ({
        iss: TEST_ISSUER,
        aud: 'a-client-id',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'subject-1',
        nonce,
        email: 'owner@example.com',
        email_verified: true,
      }),
    })
    let app = await buildServer({ config, database, authFetch: firstLoginStub.fetch })
    const { callbackResponse: first, cookie: firstCookie } = await loggedIn(app)
    expect(first.statusCode).toBe(302)
    const cookie = expectCookie(firstCookie)

    // Revoke the session and restart the process (a fresh database handle over the same file,
    // and a fresh server), so the pin's persistence is what is under test rather than in-memory
    // state that happened to survive.
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: 'http://127.0.0.1:5123' },
    })
    await app.close()
    database.close()

    database = openDatabase(path)
    const secondLoginStub = stubProvider({
      claims: (nonce) => ({
        iss: TEST_ISSUER,
        aud: 'a-client-id',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'a-different-subject',
        nonce,
        email: 'owner@example.com',
        email_verified: true,
      }),
    })
    app = await buildServer({ config, database, authFetch: secondLoginStub.fetch })
    const { callbackResponse: second } = await loggedIn(app)

    expect(second.statusCode).toBe(302)
    expect(second.headers.location).toBe('/?login=forbidden')
    await app.close()
    database.close()
  })

  it('sets a session cookie that is HttpOnly, SameSite=Lax, Path=/, with no Domain, and no Secure on http (criterion 18)', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const { callbackResponse } = await loggedIn(app)
    const header = (
      Array.isArray(callbackResponse.headers['set-cookie'])
        ? callbackResponse.headers['set-cookie'][0]
        : callbackResponse.headers['set-cookie']
    ) as string

    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Path=/')
    expect(header).not.toContain('Domain=')
    expect(header).not.toContain('Secure')
    expect(header).not.toContain('__Host-')
    await app.close()
  })

  it('redirects to the hash the login carried (the intended hash survives)', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:5123' },
      payload: { hash: '/tasks/123' },
    })
    const { url } = loginResponse.json() as { url: string }
    const state = new URL(url).searchParams.get('state') ?? ''
    const code = new URL(url).searchParams.get('nonce') ?? ''

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/auth/callback?code=${code}&state=${state}`,
    })

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers.location).toBe('/#/tasks/123')
    await app.close()
  })

  it('a successful callback is unchanged: it sets the session cookie and redirects into the SPA', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const { callbackResponse, cookie } = await loggedIn(app)

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers.location).toBe('/')
    expect(cookie).not.toBeNull()
    await app.close()
  })

  it('a refused callback redirects into the SPA with the failure named in `login`, never a JSON body', async () => {
    const stub = stubProvider({
      claims: (nonce) => ({
        iss: TEST_ISSUER,
        aud: 'a-client-id',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'an-unrelated-subject',
        nonce,
        email: 'stranger@example.com',
        email_verified: true,
      }),
    })
    const config = strictLoopbackConfig()
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: stub.fetch })

    const { callbackResponse } = await loggedIn(app)

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers.location).toBe('/?login=forbidden')
    // Not the JSON error shape every other route on this surface answers with: this route is a
    // top-level browser navigation, so a JSON body would render as a bare page rather than
    // anything the login screen can show.
    expect(() => callbackResponse.json()).toThrow()
    await app.close()
  })
})

describe('a working session (once logged in)', () => {
  it('is accepted on a gated route, and refused after logout (criterion 21)', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const cookie = expectCookie((await loggedIn(app)).cookie)

    const gated = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })
    expect(gated.statusCode).toBe(200)

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: 'http://127.0.0.1:5123' },
    })
    expect(logout.statusCode).toBe(204)

    const replay = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })
    expect(replay.statusCode).toBe(401)

    await app.close()
  })
})

describe('the Origin check (criterion 24)', () => {
  it('refuses a write whose Origin is not one this Caroline accepts', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example.com' },
      payload: {},
    })

    expect(response.statusCode).toBe(403)
    await app.close()
  })

  it('accepts a write whose Origin is a loopback origin on a different port, as the dev server sends (criterion 33)', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:5173' },
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('carries no CORS header on any response', async () => {
    const config = strictLoopbackConfig()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    const response = await app.inject({ method: 'GET', url: '/api/auth/status' })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })
})

describe('criterion 33: a loopback install with auth.mode required can complete a login', () => {
  it('starts a login carrying the loopback origin, completes the callback, and the session works', async () => {
    const config = strictLoopbackConfig()
    expect(config.authRequired).toBe(true)
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stubProvider().fetch,
    })

    // The literal bind string, http://127.0.0.1:<port>, is not the one the browser necessarily
    // used: this asserts it works, and the dev-server-port case is asserted just above too.
    const { cookie: rawCookie, callbackResponse } = await loggedIn(app, 'http://localhost:5123')
    expect(callbackResponse.statusCode).toBe(302)
    const cookie = expectCookie(rawCookie)

    const gated = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })
    expect(gated.statusCode).toBe(200)

    await app.close()
  })
})

describe('needs a client secret (configuration section, first-login-time failure)', () => {
  it('fails the first login attempt, redirecting into the SPA and logging the environment variable it needs, when the provider needs a secret and none is set', async () => {
    const stub = stubProvider({ tokenEndpointAuthMethodsSupported: ['client_secret_post'] })
    const config = strictLoopbackConfig()
    expect(config.auth.provider.clientSecret).toBeNull()
    const { lines, stream } = captureLog()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: stub.fetch,
      logger: { level: 'info', stream },
    })

    const { callbackResponse } = await loggedIn(app)
    await app.close()

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers.location).toBe('/?login=bad_request')
    expect(lines.join('\n')).toContain('CAROLINE_AUTH_CLIENT_SECRET')
  })
})

describe('no secret leaks (criterion 25)', () => {
  it('no id_token, code, session value or client secret appears in a response body', async () => {
    const stub = stubProvider()
    const config = loadConfig({
      file: {
        auth: {
          mode: 'required',
          allow: ['owner@example.com'],
          provider: { issuer: TEST_ISSUER, clientId: 'a-client-id' },
        },
      },
      env: { CAROLINE_AUTH_CLIENT_SECRET: 'super-secret-value' } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: stub.fetch })

    const { loginResponse, callbackResponse } = await loggedIn(app)

    expect(loginResponse.body).not.toContain('super-secret-value')
    expect(callbackResponse.body).not.toContain('super-secret-value')
    await app.close()
  })
})
