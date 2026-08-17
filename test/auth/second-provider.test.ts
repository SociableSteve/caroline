/**
 * Spec 13, slice 3: the whole login flow proven against a second provider, so `src/auth/` is
 * shown to be generic rather than merely described as generic. Everything the fetch stub below
 * returns is read from `test/fixtures/oidc/`, a recorded discovery document and a recorded set
 * of identity claims for a fictional provider that is not Google (see that directory's README
 * for which fields are recorded and which two the protocol itself makes impossible to record:
 * `exp` and `nonce`). No line below names a Google endpoint, which is criterion 27's own test.
 *
 * Criteria covered: 27 (the whole flow, fixture-driven, no code change to `src/auth/`), 29 (a
 * `sub:`-only identity, and an unverified email matching no address entry) and 30 (a `none`
 * client authenticates with PKCE and no secret; a confidential-only provider with no secret
 * configured fails the first login attempt, not startup).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { buildServer } from '../../src/server/app.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { fakeIdToken } from '../helpers/oidc.js'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const fixturesDir = join(repositoryRoot, 'test', 'fixtures', 'oidc')

/** Matches `test/server/routes/auth.test.ts`'s helper: a writable that keeps every line rather
 * than writing to a real stream, so a test can assert on what was logged. */
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

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T
}

interface DiscoveryFixture {
  readonly issuer: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  readonly code_challenge_methods_supported: readonly string[]
  readonly token_endpoint_auth_methods_supported: readonly string[]
}

interface IdentityFixture {
  readonly sub: string
  readonly email?: string
  readonly email_verified?: boolean
}

const noEnv = {} as NodeJS.ProcessEnv

/**
 * Serves the recorded discovery document verbatim, and builds the token response's `id_token`
 * from the recorded identity claims plus the two fields no fixture can carry: `exp`, filled in
 * as "an hour from now" so the fixture never goes stale, and `nonce`, echoed back exactly as a
 * real provider would from whatever the authorization request carried. `clientId` is read off
 * the request rather than recorded, so the fixture does not have to agree with every config a
 * test builds against it.
 */
function secondProviderFetch(
  discovery: DiscoveryFixture,
  identity: IdentityFixture,
): { fetch: typeof globalThis.fetch; tokenRequests: Array<Record<string, string>> } {
  const tokenRequests: Array<Record<string, string>> = []

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)

    if (url === `${discovery.issuer}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify(discovery), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    if (url === discovery.token_endpoint) {
      const fields: Record<string, string> = {}
      for (const [key, value] of new URLSearchParams(String(init?.body ?? ''))) {
        fields[key] = value
      }
      tokenRequests.push(fields)

      // The stub has no front channel to read the nonce from, so as elsewhere in this suite
      // (test/helpers/oidc.ts), the test drives the flow by passing the nonce through as the
      // authorization code, and reads it back out here.
      const idToken = fakeIdToken({
        ...identity,
        iss: discovery.issuer,
        aud: fields.client_id,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: fields.code,
      })

      return new Response(JSON.stringify({ token_type: 'Bearer', id_token: idToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    throw new Error(`The second-provider stub was not expecting a request to ${url}`)
  }

  return { fetch, tokenRequests }
}

function configFor(
  discovery: DiscoveryFixture,
  allow: readonly string[],
  env: NodeJS.ProcessEnv = noEnv,
) {
  return loadConfig({
    file: {
      auth: {
        mode: 'required',
        allow,
        provider: { issuer: discovery.issuer, clientId: 'second-provider-client-id' },
      },
    },
    env,
  })
}

async function runLoginAndCallback(app: Awaited<ReturnType<typeof buildServer>>): Promise<{
  loginResponse: Awaited<ReturnType<typeof app.inject>>
  callbackResponse: Awaited<ReturnType<typeof app.inject>>
}> {
  const loginResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://127.0.0.1:5123' },
    payload: {},
  })
  const { url } = loginResponse.json() as { url: string }
  const parsed = new URL(url)
  const state = parsed.searchParams.get('state') ?? ''
  const code = parsed.searchParams.get('nonce') ?? ''

  const callbackResponse = await app.inject({
    method: 'GET',
    url: `/api/auth/callback?code=${code}&state=${state}`,
  })

  return { loginResponse, callbackResponse }
}

describe('the whole flow against a second provider (criterion 27)', () => {
  it('runs discovery, the authorization URL, the callback, the token exchange, id_token validation, the allowlist and the session, with no code change to src/auth', async () => {
    const discovery = fixture<DiscoveryFixture>('discovery-public-client.json')
    const identity = fixture<IdentityFixture>('identity-with-verified-email.json')
    const { fetch } = secondProviderFetch(discovery, identity)

    const config = configFor(discovery, [identity.email as string])
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: fetch })

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:5123' },
      payload: {},
    })
    expect(loginResponse.statusCode).toBe(200)
    const { url } = loginResponse.json() as { url: string }
    const parsed = new URL(url)

    // The authorization URL is built entirely from the recorded discovery document: this is the
    // point at which a Google endpoint would have leaked in, had one been hardcoded anywhere.
    expect(parsed.origin).toBe(new URL(discovery.authorization_endpoint).origin)
    expect(parsed.pathname).toBe(new URL(discovery.authorization_endpoint).pathname)

    const state = parsed.searchParams.get('state') ?? ''
    const code = parsed.searchParams.get('nonce') ?? ''

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/auth/callback?code=${code}&state=${state}`,
    })
    expect(callbackResponse.statusCode).toBe(302)
    const setCookie = callbackResponse.headers['set-cookie']
    expect(setCookie).toBeDefined()
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] as string

    const gated = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })
    expect(gated.statusCode).toBe(200)

    await app.close()
  })
})

describe('a provider returning no email claim (criterion 29)', () => {
  it('is usable through an allowlist entry naming its subject', async () => {
    const discovery = fixture<DiscoveryFixture>('discovery-public-client.json')
    const identity = fixture<IdentityFixture>('identity-sub-only.json')
    expect(identity.email).toBeUndefined()
    const { fetch } = secondProviderFetch(discovery, identity)

    const config = configFor(discovery, [`sub:${identity.sub}`])
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: fetch })

    const { callbackResponse } = await runLoginAndCallback(app)

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers['set-cookie']).toBeDefined()
    await app.close()
  })

  it('is refused by an allowlist entry naming an address, with no sub: entry present', async () => {
    const discovery = fixture<DiscoveryFixture>('discovery-public-client.json')
    const identity = fixture<IdentityFixture>('identity-sub-only.json')
    const { fetch } = secondProviderFetch(discovery, identity)

    const config = configFor(discovery, ['someone@fictional-idp.test'])
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: fetch })

    const { callbackResponse } = await runLoginAndCallback(app)

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers.location).toBe('/?login=forbidden')
    expect(callbackResponse.headers['set-cookie']).toBeUndefined()
    await app.close()
  })
})

describe('an email claim without email_verified: true (criterion 29)', () => {
  it('matches no address entry, even the one naming the same address', async () => {
    const discovery = fixture<DiscoveryFixture>('discovery-public-client.json')
    const identity = fixture<IdentityFixture>('identity-with-unverified-email.json')
    expect(identity.email_verified).toBe(false)
    const { fetch } = secondProviderFetch(discovery, identity)

    const config = configFor(discovery, [identity.email as string])
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: fetch })

    const { callbackResponse } = await runLoginAndCallback(app)

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers.location).toBe('/?login=forbidden')
    expect(callbackResponse.headers['set-cookie']).toBeUndefined()
    await app.close()
  })
})

describe('a discovery document offering none (criterion 30)', () => {
  it('authenticates with PKCE and no client secret', async () => {
    const discovery = fixture<DiscoveryFixture>('discovery-public-client.json')
    expect(discovery.token_endpoint_auth_methods_supported).toContain('none')
    const identity = fixture<IdentityFixture>('identity-with-verified-email.json')
    const { fetch, tokenRequests } = secondProviderFetch(discovery, identity)

    const config = configFor(discovery, [identity.email as string])
    expect(config.auth.provider.clientSecret).toBeNull()
    const app = await buildServer({ config, database: migratedDatabase(), authFetch: fetch })

    const { callbackResponse } = await runLoginAndCallback(app)

    expect(callbackResponse.statusCode).toBe(302)
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]?.client_secret).toBeUndefined()
    expect(tokenRequests[0]?.code_verifier).toBeTruthy()
    await app.close()
  })
})

describe('a discovery document not offering none, no secret configured (criterion 30)', () => {
  it('starts successfully: nothing has been fetched yet', () => {
    const discovery = fixture<DiscoveryFixture>('discovery-confidential-client.json')
    expect(discovery.token_endpoint_auth_methods_supported).not.toContain('none')

    expect(() => configFor(discovery, ['owner@fictional-idp.test'])).not.toThrow()
  })

  it('fails the first login attempt, not startup, redirecting into the SPA and logging CAROLINE_AUTH_CLIENT_SECRET and the advertised methods', async () => {
    const discovery = fixture<DiscoveryFixture>('discovery-confidential-client.json')
    const identity = fixture<IdentityFixture>('identity-with-verified-email.json')
    const { fetch } = secondProviderFetch(discovery, identity)

    const config = configFor(discovery, [identity.email as string])
    expect(config.auth.provider.clientSecret).toBeNull()
    const { lines, stream } = captureLog()
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      authFetch: fetch,
      logger: { level: 'info', stream },
    })

    // The login step itself succeeds: it only builds the authorization URL, and does not yet
    // know whether a secret will be needed.
    const { loginResponse, callbackResponse } = await runLoginAndCallback(app)
    expect(loginResponse.statusCode).toBe(200)
    await app.close()

    expect(callbackResponse.statusCode).toBe(302)
    expect(callbackResponse.headers.location).toBe('/?login=bad_request')
    const message = lines.join('\n')
    expect(message).toContain('CAROLINE_AUTH_CLIENT_SECRET')
    for (const method of discovery.token_endpoint_auth_methods_supported) {
      expect(message).toContain(method)
    }
  })
})
