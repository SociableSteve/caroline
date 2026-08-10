/**
 * The Google OAuth desktop flow, as far as HTTP goes. No file access and no configuration:
 * this builds the URL, exchanges the code and refreshes the token, and nothing else. Spec 09.
 *
 * Read-only scopes, and only the two spec 09 names. They are requested together rather than
 * one per milestone, because a scope added later needs the whole consent flow walking again and
 * a self-hoster following the setup guide should do that once.
 */
import { createHash, randomBytes } from 'node:crypto'

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export const GOOGLE_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
]

/** How long a single token request may take before it is given up on. */
export const TOKEN_TIMEOUT_MS = 20_000

/**
 * How early a token is treated as expired, so a call does not start with three seconds of
 * validity left and finish without any.
 */
export const EXPIRY_MARGIN_MS = 60_000

/** A Google authentication step that failed. Its message reaches the run history and the UI. */
export class GoogleAuthError extends Error {
  override readonly name = 'GoogleAuthError'
}

export interface TokenSet {
  readonly accessToken: string
  /**
   * Absent from a refresh response, and from a re-consent Google decides is a repeat. The
   * caller keeps the one it already had rather than losing access on a refresh.
   */
  readonly refreshToken: string | null
  /** Absolute, in epoch milliseconds, rather than the relative seconds Google sends. */
  readonly expiresAt: number
  readonly scope: string | null
}

/** PKCE, so the code is useless to anything that intercepts the loopback redirect. */
export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

export function createPkce(): Pkce {
  // 32 bytes is 43 base64url characters, the shortest verifier the spec allows and plenty.
  const verifier = base64Url(randomBytes(32))
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) }
}

/** Opaque, and checked on the way back, so a stray callback cannot complete somebody's flow. */
export function createState(): string {
  return base64Url(randomBytes(16))
}

export interface AuthorizationUrlOptions {
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
  readonly scopes?: readonly string[]
}

export function authorizationUrl({
  clientId,
  redirectUri,
  state,
  codeChallenge,
  scopes = GOOGLE_SCOPES,
}: AuthorizationUrlOptions): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)

  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // A refresh token only arrives with consent explicitly asked for, and only offline access
    // gets one at all. Without both, Caroline would work until the first access token expired.
    access_type: 'offline',
    prompt: 'consent',
  }).toString()

  return url.toString()
}

interface TokenResponse {
  readonly access_token?: unknown
  readonly refresh_token?: unknown
  readonly expires_in?: unknown
  readonly scope?: unknown
  readonly error?: unknown
  readonly error_description?: unknown
}

export interface TokenRequestOptions {
  readonly clientId: string
  readonly clientSecret: string
  /** Injected so nothing in the suite reaches Google. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly timeoutMs?: number
}

async function requestToken(
  body: Record<string, string>,
  {
    clientId,
    clientSecret,
    fetch = globalThis.fetch,
    now = () => Date.now(),
    timeoutMs = TOKEN_TIMEOUT_MS,
  }: TokenRequestOptions,
): Promise<TokenSet> {
  let response: Response
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...body,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new GoogleAuthError(`Google did not answer the token request within ${timeoutMs}ms`)
    }
    throw error
  }

  const payload = (await response.json().catch(() => null)) as TokenResponse | null

  if (!response.ok || typeof payload?.access_token !== 'string') {
    // Google's own words, which are the useful part: `invalid_grant` means the refresh token
    // has been revoked and the user has to consent again, and nothing else says that.
    const detail =
      typeof payload?.error_description === 'string'
        ? payload.error_description
        : typeof payload?.error === 'string'
          ? payload.error
          : `${response.status} ${response.statusText}`
    throw new GoogleAuthError(`Google refused the token request: ${detail}`)
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 0

  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    expiresAt: now() + expiresIn * 1000,
    scope: typeof payload.scope === 'string' ? payload.scope : null,
  }
}

export interface ExchangeOptions extends TokenRequestOptions {
  readonly code: string
  readonly redirectUri: string
  readonly codeVerifier: string
}

export function exchangeCode({
  code,
  redirectUri,
  codeVerifier,
  ...options
}: ExchangeOptions): Promise<TokenSet> {
  return requestToken(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
    options,
  )
}

export interface RefreshOptions extends TokenRequestOptions {
  readonly refreshToken: string
}

export function refreshAccessToken({
  refreshToken,
  ...options
}: RefreshOptions): Promise<TokenSet> {
  return requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, options)
}

/** True when the token has expired, or is close enough to it not to be worth starting a call. */
export function isExpired(expiresAt: number, now: number): boolean {
  return expiresAt - EXPIRY_MARGIN_MS <= now
}
