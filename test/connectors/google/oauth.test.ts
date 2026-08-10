/**
 * The Google OAuth desktop flow and the token file. Spec 09: read-only scopes, PKCE, and a token
 * file at mode 0600 beside the database. Nothing here reaches Google.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../../src/config/load.js'
import { secretValues } from '../../../src/config/redact.js'
import { createGoogleAuth, redirectUriFor } from '../../../src/connectors/google/auth.js'
import {
  authorizationUrl,
  createPkce,
  exchangeCode,
  GOOGLE_SCOPES,
  GoogleAuthError,
  isExpired,
  refreshAccessToken,
} from '../../../src/connectors/google/oauth.js'
import { readTokens, writeTokens } from '../../../src/connectors/google/tokens.js'
import { stubTokenEndpoint } from '../../helpers/google.js'
import { temporaryDatabasePath } from '../../helpers/temp-database.js'

const NOW = Date.UTC(2026, 7, 10, 9, 0, 0)

function configuredAt(databasePath: string) {
  return loadConfig({
    file: {
      database: { path: databasePath },
      integrations: { google: { clientId: 'client-123' } },
    },
    env: { GOOGLE_CLIENT_SECRET: 'secret-456' } as unknown as NodeJS.ProcessEnv,
  })
}

describe('the authorisation URL', () => {
  it('asks for the two read-only scopes and nothing else', () => {
    const pkce = createPkce()
    const url = new URL(
      authorizationUrl({
        clientId: 'client-123',
        redirectUri: 'http://127.0.0.1:5123/api/integrations/google/callback',
        state: 'state-1',
        codeChallenge: pkce.challenge,
      }),
    )

    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...GOOGLE_SCOPES])
    expect(url.searchParams.get('scope')).not.toMatch(/gmail\.(modify|send|compose)/)
  })

  it('asks for offline access and consent, which is what returns a refresh token', () => {
    const url = new URL(
      authorizationUrl({
        clientId: 'client-123',
        redirectUri: 'http://127.0.0.1:5123/api/integrations/google/callback',
        state: 'state-1',
        codeChallenge: 'challenge',
      }),
    )

    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('never carries the client secret', () => {
    const url = authorizationUrl({
      clientId: 'client-123',
      redirectUri: 'http://127.0.0.1:5123/api/integrations/google/callback',
      state: 'state-1',
      codeChallenge: 'challenge',
    })

    expect(url).not.toContain('secret')
  })
})

describe('PKCE', () => {
  it('produces a fresh verifier each time, with its S256 challenge', () => {
    const first = createPkce()
    const second = createPkce()

    expect(first.verifier).not.toBe(second.verifier)
    expect(first.verifier.length).toBeGreaterThanOrEqual(43)
    expect(first.challenge).not.toBe(first.verifier)
    // base64url: no padding and none of the three characters that would need escaping in a URL.
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('exchanging the code', () => {
  it('sends the verifier and turns the relative expiry into an absolute one', async () => {
    const stub = stubTokenEndpoint([
      {
        body: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3599,
          scope: GOOGLE_SCOPES.join(' '),
        },
      },
    ])

    const tokens = await exchangeCode({
      code: 'code-1',
      redirectUri: 'http://127.0.0.1:5123/api/integrations/google/callback',
      codeVerifier: 'verifier-1',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      fetch: stub.fetch,
      now: () => NOW,
    })

    expect(tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3_599_000,
      scope: GOOGLE_SCOPES.join(' '),
    })
  })

  it('reports Google’s own words when it refuses', async () => {
    const stub = stubTokenEndpoint([
      {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Code was already redeemed' },
      },
    ])

    await expect(
      exchangeCode({
        code: 'code-1',
        redirectUri: 'http://127.0.0.1:5123/api/integrations/google/callback',
        codeVerifier: 'verifier-1',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        fetch: stub.fetch,
      }),
    ).rejects.toThrow(/Code was already redeemed/)
  })
})

describe('refreshing', () => {
  it('asks for a refresh grant and accepts a response with no new refresh token', async () => {
    const stub = stubTokenEndpoint([{ body: { access_token: 'access-2', expires_in: 3600 } }])

    const tokens = await refreshAccessToken({
      refreshToken: 'refresh-1',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      fetch: stub.fetch,
      now: () => NOW,
    })

    expect(tokens).toMatchObject({ accessToken: 'access-2', refreshToken: null })
  })
})

describe('expiry', () => {
  it('treats a token about to expire as expired, so a call does not start on the edge', () => {
    expect(isExpired(NOW + 30_000, NOW)).toBe(true)
    expect(isExpired(NOW + 600_000, NOW)).toBe(false)
  })
})

describe('the token file', () => {
  it('is written owner-only, which is the whole of the protection', () => {
    const path = join(temporaryDatabasePath(), '..', 'google-tokens.json')

    writeTokens(path, {
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresAt: NOW,
      scope: null,
      connectedAt: NOW,
    })

    // The permission bits are a bit field, so they are read as one.
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('reads back what was written', () => {
    const path = join(temporaryDatabasePath(), '..', 'google-tokens.json')
    const tokens = {
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresAt: NOW + 3600_000,
      scope: 'a b',
      connectedAt: NOW,
    }

    writeTokens(path, tokens)

    expect(readTokens(path)).toEqual(tokens)
  })

  it('is absent rather than empty on a Caroline nobody has connected', () => {
    expect(readTokens(join(temporaryDatabasePath(), '..', 'google-tokens.json'))).toBeNull()
  })

  /**
   * An interrupted write used to leave a file `JSON.parse` threw on, and `createGoogleAuth` reads
   * this during construction, so the process could not start until somebody deleted it by hand.
   */
  it('is treated as absent when it is not valid JSON', () => {
    const config = configuredAt(temporaryDatabasePath())
    const path = config.integrations.google.tokenPath
    mkdirSync(dirname(path), { recursive: true })
    // Truncated exactly as an interrupted write would leave it.
    writeFileSync(path, '{"refreshToken": "refresh-1"')

    expect(readTokens(path)).toBeNull()
    // The process still starts, which is the point: this is read during construction.
    expect(() => createGoogleAuth({ config, now: () => NOW })).not.toThrow()
    expect(createGoogleAuth({ config, now: () => NOW }).isConnected()).toBe(false)
  })

  it('is written by rename, so no half-written file is left behind', () => {
    const path = join(temporaryDatabasePath(), '..', 'google-tokens.json')

    writeTokens(path, {
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresAt: NOW,
      scope: null,
      connectedAt: NOW,
    })

    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(readTokens(path)).not.toBeNull()
  })

  it('is treated as absent when it holds no refresh token, since it could get nothing', () => {
    const path = join(temporaryDatabasePath(), '..', 'google-tokens.json')
    writeTokens(path, {
      refreshToken: '',
      accessToken: 'access-1',
      expiresAt: NOW,
      scope: null,
      connectedAt: NOW,
    })

    expect(readTokens(path)).toBeNull()
  })
})

describe('the connection', () => {
  it('is not connected before consent, and says what it needs', async () => {
    const config = configuredAt(temporaryDatabasePath())
    const auth = createGoogleAuth({ config, now: () => NOW })

    expect(auth.isConnected()).toBe(false)
    expect(auth.status()).toMatchObject({ connected: false, configured: true })
    await expect(auth.accessToken()).rejects.toThrow(GoogleAuthError)
  })

  it('refuses to start consent with no credentials', () => {
    const config = loadConfig({
      file: { database: { path: temporaryDatabasePath() } },
      env: {} as NodeJS.ProcessEnv,
    })

    expect(() => createGoogleAuth({ config, now: () => NOW }).begin()).toThrow(/not configured/)
  })

  it('completes the flow, persists the tokens and reports itself connected', async () => {
    const config = configuredAt(temporaryDatabasePath())
    const stub = stubTokenEndpoint([
      {
        body: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: 'a',
        },
      },
    ])
    const auth = createGoogleAuth({ config, fetch: stub.fetch, now: () => NOW })

    const { state } = auth.begin()
    await auth.complete('code-1', state)

    expect(auth.status()).toMatchObject({ connected: true, connectedAt: NOW, scopes: ['a'] })
    expect(readTokens(config.integrations.google.tokenPath)).toMatchObject({
      refreshToken: 'refresh-1',
    })
  })

  it('rejects a callback whose state is not the one it handed out', async () => {
    const config = configuredAt(temporaryDatabasePath())
    const auth = createGoogleAuth({ config, now: () => NOW })
    auth.begin()

    await expect(auth.complete('code-1', 'somebody-elses-state')).rejects.toThrow(/does not match/)
  })

  it('refuses a callback when no flow is in progress', async () => {
    const config = configuredAt(temporaryDatabasePath())
    const auth = createGoogleAuth({ config, now: () => NOW })

    await expect(auth.complete('code-1', 'state-1')).rejects.toThrow(/no Google authorisation/i)
  })

  it('spends the code once, so a replayed callback does not exchange it again', async () => {
    const config = configuredAt(temporaryDatabasePath())
    const stub = stubTokenEndpoint([
      { body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 } },
    ])
    const auth = createGoogleAuth({ config, fetch: stub.fetch, now: () => NOW })

    const { state } = auth.begin()
    await auth.complete('code-1', state)

    await expect(auth.complete('code-1', state)).rejects.toThrow(/no Google authorisation/i)
    expect(stub.requests).toHaveLength(1)
  })

  it('refreshes an expired access token and keeps the refresh token it already had', async () => {
    const config = configuredAt(temporaryDatabasePath())
    writeTokens(config.integrations.google.tokenPath, {
      refreshToken: 'refresh-1',
      accessToken: 'stale',
      expiresAt: NOW - 1000,
      scope: 'a',
      connectedAt: NOW - 86_400_000,
    })

    const stub = stubTokenEndpoint([{ body: { access_token: 'access-2', expires_in: 3600 } }])
    const auth = createGoogleAuth({ config, fetch: stub.fetch, now: () => NOW })

    expect(await auth.accessToken()).toBe('access-2')
    expect(readTokens(config.integrations.google.tokenPath)).toMatchObject({
      refreshToken: 'refresh-1',
      accessToken: 'access-2',
      // Consent was given a day ago and refreshing is not consent.
      connectedAt: NOW - 86_400_000,
    })
  })

  it('does not refresh a token that is still good', async () => {
    const config = configuredAt(temporaryDatabasePath())
    writeTokens(config.integrations.google.tokenPath, {
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresAt: NOW + 3600_000,
      scope: null,
      connectedAt: NOW,
    })

    const stub = stubTokenEndpoint([{ body: {} }])
    const auth = createGoogleAuth({ config, fetch: stub.fetch, now: () => NOW })

    expect(await auth.accessToken()).toBe('access-1')
    expect(stub.requests).toEqual([])
  })

  it('forgets the tokens when disconnected', () => {
    const config = configuredAt(temporaryDatabasePath())
    writeTokens(config.integrations.google.tokenPath, {
      refreshToken: 'refresh-1',
      accessToken: null,
      expiresAt: null,
      scope: null,
      connectedAt: NOW,
    })

    const auth = createGoogleAuth({ config, now: () => NOW })

    expect(auth.disconnect()).toBe(true)
    expect(auth.isConnected()).toBe(false)
    expect(readTokens(config.integrations.google.tokenPath)).toBeNull()
  })

  /**
   * Spec 09, criterion 6. Neither token comes from the configuration, so the log scrubber has to be
   * told about them or it could not scrub what it has never seen.
   */
  it('registers its tokens as secrets to be scrubbed', () => {
    const config = configuredAt(temporaryDatabasePath())
    writeTokens(config.integrations.google.tokenPath, {
      refreshToken: 'refresh-token-value',
      accessToken: 'access-token-value',
      expiresAt: NOW + 3600_000,
      scope: null,
      connectedAt: NOW,
    })

    createGoogleAuth({ config, now: () => NOW })

    expect(secretValues(config)).toContain('refresh-token-value')
    expect(secretValues(config)).toContain('access-token-value')
  })

  it('puts the token file beside the database and nowhere else', () => {
    const databasePath = temporaryDatabasePath()
    const config = configuredAt(databasePath)

    expect(config.integrations.google.tokenPath).toBe(
      join(databasePath, '..', 'google-tokens.json'),
    )
  })

  it('sends Google back to the loopback address it is listening on', () => {
    const config = configuredAt(temporaryDatabasePath())

    expect(redirectUriFor(config)).toBe('http://127.0.0.1:5123/api/integrations/google/callback')
  })

  /**
   * An unbracketed IPv6 host is not a URL Google will accept, and it fails at consent time rather
   * than at startup, which is the hard place to diagnose it.
   */
  it('brackets an IPv6 host', () => {
    const config = configuredAt(temporaryDatabasePath())

    expect(redirectUriFor({ ...config, server: { ...config.server, host: '::1' } })).toBe(
      'http://[::1]:5123/api/integrations/google/callback',
    )
  })

  it('says what to do when Google returns no refresh token to keep', async () => {
    const config = configuredAt(temporaryDatabasePath())
    const stub = stubTokenEndpoint([{ body: { access_token: 'access-1', expires_in: 3600 } }])
    const auth = createGoogleAuth({ config, fetch: stub.fetch, now: () => NOW })

    const { state } = auth.begin()

    await expect(auth.complete('code-1', state)).rejects.toThrow(/no refresh token/i)
    expect(auth.isConnected()).toBe(false)
  })

  /**
   * Two callers arriving on an expired token would each POST a refresh, write the file twice, and
   * leave the earlier access token discarded while a caller still held it.
   */
  it('shares one refresh between concurrent callers', async () => {
    const config = configuredAt(temporaryDatabasePath())
    writeTokens(config.integrations.google.tokenPath, {
      refreshToken: 'refresh-1',
      accessToken: 'stale',
      expiresAt: NOW - 1000,
      scope: null,
      connectedAt: NOW,
    })

    const stub = stubTokenEndpoint([{ body: { access_token: 'access-2', expires_in: 3600 } }])
    const auth = createGoogleAuth({ config, fetch: stub.fetch, now: () => NOW })

    const [first, second] = await Promise.all([auth.accessToken(), auth.accessToken()])

    expect([first, second]).toEqual(['access-2', 'access-2'])
    expect(stub.requests).toHaveLength(1)
  })

  it('tries again after a refresh that failed rather than answering with the failure forever', async () => {
    const config = configuredAt(temporaryDatabasePath())
    writeTokens(config.integrations.google.tokenPath, {
      refreshToken: 'refresh-1',
      accessToken: 'stale',
      expiresAt: NOW - 1000,
      scope: null,
      connectedAt: NOW,
    })

    const stub = stubTokenEndpoint([
      { status: 500, body: { error: 'backend_error' } },
      { body: { access_token: 'access-2', expires_in: 3600 } },
    ])
    const auth = createGoogleAuth({ config, fetch: stub.fetch, now: () => NOW })

    await expect(auth.accessToken()).rejects.toThrow(GoogleAuthError)

    expect(await auth.accessToken()).toBe('access-2')
  })
})
