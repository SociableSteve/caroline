/**
 * `GET /api/mcp/authorize`, the consent screen's own two routes, `POST /api/mcp/token`, the
 * approved-clients list and the two well-known metadata documents. Spec 12, slice 3.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { Config } from '../../../src/config/schema.js'
import { canonicalResourceUri } from '../../../src/mcp/oauth/resource.js'
import { testConfig, testServer, REQUEST_TIME } from '../../helpers/test-server.js'
import type { ClientMetadataDocument } from '../../../src/mcp/oauth/client-metadata.js'

function mcpConfig(): Config {
  return { ...testConfig, mcp: { ...testConfig.mcp, enabled: true } }
}

const CLIENT_ID = 'https://example.com/mcp-client.json'
const REDIRECT_URI = 'http://127.0.0.1:51820/callback'

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest().toString('base64url')
  return { verifier, challenge }
}

function stubMetadata(overrides: Partial<ClientMetadataDocument> = {}) {
  return async (clientId: string) => ({
    clientId,
    clientName: 'Example client',
    clientUri: 'https://example.com',
    redirectUris: [REDIRECT_URI],
    ...overrides,
  })
}

describe('GET /api/mcp/authorize', () => {
  it('redirects to the consent screen on Settings for a client seen for the first time', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { challenge } = pkce()

    const response = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`,
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toMatch(/^\/#\/settings\?mcpRequest=/)
  })

  it('is not rejected for carrying a scope param, though spec 12 defines none for this slice', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { challenge } = pkce()

    const response = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent('mcp:tools')}`,
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toMatch(/^\/#\/settings\?mcpRequest=/)
  })

  it('refuses a request with no PKCE challenge, or a method other than S256 (criterion 27)', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })

    const noChallenge = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    })
    expect(noChallenge.statusCode).toBe(400)

    const { challenge } = pkce()
    const plainMethod = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=plain`,
    })
    expect(plainMethod.statusCode).toBe(400)
  })

  it('refuses a redirect_uri that is neither loopback nor https (criterion 30)', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { challenge } = pkce()

    const response = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent('ftp://example.com/callback')}&code_challenge=${challenge}&code_challenge_method=S256`,
    })

    expect(response.statusCode).toBe(400)
  })

  it('refuses a redirect_uri the client does not declare in its own metadata document', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata({
        redirectUris: ['https://otherhost.example.com/callback'],
      }),
    })
    const { challenge } = pkce()

    const response = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`,
    })

    expect(response.statusCode).toBe(400)
  })

  it('redirects straight to the client with a code for one already approved, no consent screen (criterion 31)', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { verifier, challenge } = pkce()

    const first = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`,
    })
    const requestId = new URLSearchParams(first.headers.location!.toString().split('?')[1]).get(
      'mcpRequest',
    )!

    await app.inject({
      method: 'POST',
      url: `/api/mcp/oauth/consent/${requestId}/decide`,
      payload: { approve: true },
    })

    const { challenge: secondChallenge } = pkce()
    const second = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${secondChallenge}&code_challenge_method=S256`,
    })

    expect(second.statusCode).toBe(302)
    expect(second.headers.location).toContain(REDIRECT_URI)
    expect(second.headers.location).toContain('code=')
    void verifier
  })
})

/** Runs the whole flow to a redeemable code: authorize, read the consent view, approve it. */
async function approvedCode(app: FastifyInstance, codeChallenge: string) {
  const authorize = await app.inject({
    method: 'GET',
    url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=turn-state`,
  })
  const requestId = new URLSearchParams(authorize.headers.location!.toString().split('?')[1]).get(
    'mcpRequest',
  )!

  const view = await app.inject({ method: 'GET', url: `/api/mcp/oauth/consent/${requestId}` })
  expect(view.statusCode).toBe(200)
  expect(view.json()).toMatchObject({ clientId: CLIENT_ID, clientName: 'Example client' })

  const decided = await app.inject({
    method: 'POST',
    url: `/api/mcp/oauth/consent/${requestId}/decide`,
    payload: { approve: true },
  })
  const redirectTo = new URL(decided.json().redirectTo)
  return { code: redirectTo.searchParams.get('code')!, iss: redirectTo.searchParams.get('iss') }
}

describe('the consent screen', () => {
  it('denies a request and redirects with error=access_denied, issuing no code', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { challenge } = pkce()

    const authorize = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256&state=abc`,
    })
    const requestId = new URLSearchParams(authorize.headers.location!.toString().split('?')[1]).get(
      'mcpRequest',
    )!

    const decided = await app.inject({
      method: 'POST',
      url: `/api/mcp/oauth/consent/${requestId}/decide`,
      payload: { approve: false },
    })

    const redirectTo = new URL(decided.json().redirectTo)
    expect(redirectTo.searchParams.get('error')).toBe('access_denied')
    expect(redirectTo.searchParams.get('code')).toBeNull()
    expect(redirectTo.searchParams.get('state')).toBe('abc')
  })

  it('404s a consent view for a request that does not exist, or was already decided', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })

    const response = await app.inject({ method: 'GET', url: '/api/mcp/oauth/consent/no-such-id' })
    expect(response.statusCode).toBe(404)
  })

  it('names the authorisation server in the redirect (criterion 42, RFC 9207 iss)', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { challenge } = pkce()

    const { iss } = await approvedCode(app, challenge)
    expect(iss).toBe(canonicalResourceUri(mcpConfig()).replace(/\/api\/mcp$/, ''))
  })
})

describe('POST /api/mcp/token', () => {
  it('exchanges a valid code and PKCE verifier for an access and refresh token', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { verifier, challenge } = pkce()
    const { code } = await approvedCode(app, challenge)

    const response = await app.inject({
      method: 'POST',
      url: '/api/mcp/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.token_type).toBe('Bearer')
    expect(typeof body.access_token).toBe('string')
    expect(typeof body.refresh_token).toBe('string')
  })

  it('refuses a second redemption of the same code, and invalidates nothing else (criterion 27)', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { verifier, challenge } = pkce()
    const { code } = await approvedCode(app, challenge)

    const first = await app.inject({
      method: 'POST',
      url: '/api/mcp/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      },
    })
    expect(first.statusCode).toBe(200)
    const firstTokens = first.json()

    const second = await app.inject({
      method: 'POST',
      url: '/api/mcp/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      },
    })
    expect(second.statusCode).toBe(400)
    expect(second.json()).toMatchObject({ error: 'invalid_grant' })

    // The first exchange's own tokens still work: a second redemption attempt did not revoke them.
    const usingFirstToken = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: {
        authorization: `Bearer ${firstTokens.access_token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover',
        host: '127.0.0.1',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'server/discover' },
    })
    expect(usingFirstToken.statusCode).toBe(200)
  })

  it('refuses a token request without PKCE, or with the wrong verifier', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { challenge } = pkce()
    const { code } = await approvedCode(app, challenge)

    const response = await app.inject({
      method: 'POST',
      url: '/api/mcp/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: 'the-wrong-verifier',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('matches a loopback redirect_uri ignoring its port at redemption (criterion 30)', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata({ redirectUris: ['http://127.0.0.1/callback'] }),
    })
    const { verifier, challenge } = pkce()

    const authorize = await app.inject({
      method: 'GET',
      url: `/api/mcp/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:4000/callback')}&code_challenge=${challenge}&code_challenge_method=S256`,
    })
    const requestId = new URLSearchParams(authorize.headers.location!.toString().split('?')[1]).get(
      'mcpRequest',
    )!
    const decided = await app.inject({
      method: 'POST',
      url: `/api/mcp/oauth/consent/${requestId}/decide`,
      payload: { approve: true },
    })
    const code = new URL(decided.json().redirectTo).searchParams.get('code')!

    // Redeemed against a *different* ephemeral port than the one it was issued for: a native
    // client's own listener picks a fresh one per run.
    const response = await app.inject({
      method: 'POST',
      url: '/api/mcp/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9001/callback',
        client_id: CLIENT_ID,
        code_verifier: verifier,
      },
    })

    expect(response.statusCode).toBe(200)
  })

  it('refreshes an access token, and refuses a revoked one', async () => {
    const { app, database } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { verifier, challenge } = pkce()
    const { code } = await approvedCode(app, challenge)

    const issued = await app.inject({
      method: 'POST',
      url: '/api/mcp/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      },
    })
    const { refresh_token: refreshToken } = issued.json()

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/mcp/token',
      payload: { grant_type: 'refresh_token', refresh_token: refreshToken },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(typeof refreshed.json().access_token).toBe('string')

    const { revokeClient } = await import('../../../src/db/repositories/mcp-oauth.js')
    revokeClient(database, CLIENT_ID, REQUEST_TIME)

    const afterRevoke = await app.inject({
      method: 'POST',
      url: '/api/mcp/token',
      payload: { grant_type: 'refresh_token', refresh_token: refreshToken },
    })
    expect(afterRevoke.statusCode).toBe(400)
  })

  it('answers in the OAuth error shape, never the API envelope, for an unsupported grant type', async () => {
    const { app } = await testServer({ config: mcpConfig() })

    const response = await app.inject({
      method: 'POST',
      url: '/api/mcp/token',
      payload: { grant_type: 'password' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'unsupported_grant_type' })
    expect(response.json()).not.toHaveProperty('error.code')
  })
})

describe('the approved clients list', () => {
  it('lists an approved client and revokes it, refusing its refresh token afterwards', async () => {
    const { app } = await testServer({
      config: mcpConfig(),
      mcpClientMetadataFetch: stubMetadata(),
    })
    const { challenge } = pkce()
    await approvedCode(app, challenge)

    const list = await app.inject({ method: 'GET', url: '/api/mcp/oauth/clients' })
    expect(list.json().clients).toMatchObject([
      { clientId: CLIENT_ID, clientName: 'Example client' },
    ])

    const revoke = await app.inject({
      method: 'POST',
      url: '/api/mcp/oauth/clients/revoke',
      payload: { clientId: CLIENT_ID },
    })
    expect(revoke.statusCode).toBe(200)

    const afterRevoke = await app.inject({ method: 'GET', url: '/api/mcp/oauth/clients' })
    expect(afterRevoke.json().clients).toEqual([])
  })
})

describe('well-known metadata documents', () => {
  it('serves none of them at all with mcp.enabled false (criterion 5)', async () => {
    const { app } = await testServer({ config: testConfig })

    const resource = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
    })
    const server = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    })

    expect(resource.statusCode).toBe(404)
    expect(server.statusCode).toBe(404)
  })

  it('serves the protected resource metadata at the path-suffixed and the unsuffixed location, naming the resource and its authorisation server (criterion 26)', async () => {
    const { app } = await testServer({ config: mcpConfig() })

    const suffixed = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/api/mcp',
    })
    const unsuffixed = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
    })

    expect(suffixed.statusCode).toBe(200)
    expect(unsuffixed.statusCode).toBe(200)
    expect(suffixed.json()).toEqual(unsuffixed.json())
    expect(suffixed.json()).toMatchObject({
      resource: canonicalResourceUri(mcpConfig()),
      authorization_servers: [canonicalResourceUri(mcpConfig()).replace(/\/api\/mcp$/, '')],
    })
  })

  it('serves the authorisation server metadata advertising S256, CIMD support and no registration endpoint (criteria 26 and 31)', async () => {
    const { app } = await testServer({ config: mcpConfig() })

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    })

    expect(response.statusCode).toBe(200)
    const metadata = response.json()
    expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
    expect(metadata.client_id_metadata_document_supported).toBe(true)
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true)
    expect(metadata).not.toHaveProperty('registration_endpoint')
  })

  it('is byte-identical between the issuer and the well-known URL it was built from (criterion 42)', async () => {
    const { app } = await testServer({ config: mcpConfig() })

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    })

    const metadata = response.json()
    expect(metadata.issuer).toBe(canonicalResourceUri(mcpConfig()).replace(/\/api\/mcp$/, ''))
    // Both http on loopback: the knowing deviation spec 12 states, asserted rather than softened.
    expect(metadata.issuer.startsWith('http://')).toBe(true)
  })
})
