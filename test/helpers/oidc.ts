/**
 * A fake identity provider for the auth suite: a discovery document and a token endpoint,
 * neither of which ever reaches a network. Deliberately generic (no Google-specific field or
 * endpoint name), so a test written against this fixture is exactly the shape slice 3's
 * source-inspection test wants nothing under `src/auth/` to defeat.
 */
import { createHash, randomBytes } from 'node:crypto'

export const TEST_ISSUER = 'https://idp.example.com'
const AUTHORIZATION_ENDPOINT = 'https://idp.example.com/authorize'
const TOKEN_ENDPOINT = 'https://idp.example.com/token'

export interface StubProviderOptions {
  readonly issuer?: string
  readonly authorizationEndpoint?: string
  readonly tokenEndpoint?: string
  readonly codeChallengeMethodsSupported?: readonly string[]
  readonly tokenEndpointAuthMethodsSupported?: readonly string[]
  /** Overrides the discovery document's own `issuer` field, for a test of a mismatch. */
  readonly documentIssuer?: string
  /** A claims object built fresh per exchanged code, so a test can vary `sub`/`email` per run. */
  readonly claims?: (nonce: string | undefined) => Record<string, unknown>
  /** Replaces the token endpoint's whole response, for a test of a malformed one. */
  readonly tokenResponse?: (fields: Record<string, string>) => { status?: number; body?: unknown }
}

export interface StubProvider {
  readonly fetch: typeof globalThis.fetch
  readonly requests: Array<{ url: string; fields?: Record<string, string> }>
}

function base64UrlJson(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

/** An unsigned JWT: header and payload are real base64url JSON, the "signature" segment is
 * meaningless bytes, because Caroline never checks it (spec 13, "The identity token is
 * validated and its signature is not"). */
export function fakeIdToken(claims: Record<string, unknown>): string {
  const header = base64UrlJson({ alg: 'none', typ: 'JWT' })
  const payload = base64UrlJson(claims)
  const signature = randomBytes(8).toString('base64url')
  return `${header}.${payload}.${signature}`
}

export function stubProvider({
  issuer = TEST_ISSUER,
  authorizationEndpoint = AUTHORIZATION_ENDPOINT,
  tokenEndpoint = TOKEN_ENDPOINT,
  codeChallengeMethodsSupported = ['S256'],
  // `none`: a public client, PKCE alone protecting the exchange. Most of the suite wants a
  // login that succeeds without also having to configure a client secret; the one test that
  // wants the secret-required path overrides this explicitly.
  tokenEndpointAuthMethodsSupported = ['none'],
  documentIssuer,
  claims,
  tokenResponse,
}: StubProviderOptions = {}): StubProvider {
  const requests: Array<{ url: string; fields?: Record<string, string> }> = []

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)

    if (url === `${issuer}/.well-known/openid-configuration`) {
      requests.push({ url })
      return new Response(
        JSON.stringify({
          issuer: documentIssuer ?? issuer,
          authorization_endpoint: authorizationEndpoint,
          token_endpoint: tokenEndpoint,
          code_challenge_methods_supported: codeChallengeMethodsSupported,
          token_endpoint_auth_methods_supported: tokenEndpointAuthMethodsSupported,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === tokenEndpoint) {
      const fields: Record<string, string> = {}
      for (const [key, value] of new URLSearchParams(String(init?.body ?? ''))) {
        fields[key] = value
      }
      requests.push({ url, fields })

      if (tokenResponse !== undefined) {
        const custom = tokenResponse(fields)
        return new Response(JSON.stringify(custom.body ?? {}), {
          status: custom.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      // The token exchange carries no nonce of its own: in the real flow the authorization
      // server binds the nonce to the code when it is minted, and returns it embedded in the
      // id_token without being told it again. This stub cannot run the front-channel step a
      // browser would, so the test-side helper that drives it passes the nonce through as the
      // authorization code itself, and this is the other half of that arrangement.
      const idToken = fakeIdToken(
        claims?.(fields.code) ?? {
          iss: issuer,
          aud: fields.client_id,
          exp: Math.floor(Date.now() / 1000) + 3600,
          sub: 'subject-1',
          nonce: fields.code,
          email: 'owner@example.com',
          email_verified: true,
        },
      )

      return new Response(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    throw new Error(`The stub provider was not expecting a request to ${url}`)
  }

  return { fetch, requests }
}

/** The S256 challenge a verifier produces, for a test that wants to check what was sent without
 * importing `src/auth/pkce.ts`'s internals. */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest().toString('base64url')
}
