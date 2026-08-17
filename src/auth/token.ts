/**
 * The token exchange. Spec 13, criterion 15: the token endpoint is reached directly over
 * `https`, never through a configurable proxy, which is what lets the id_token's signature go
 * unverified. The endpoint itself is read from the (already-validated-`https`) discovery
 * document, so there is nothing here that could send this request anywhere else.
 */

export class TokenExchangeError extends Error {
  override readonly name = 'TokenExchangeError'
}

/** How long the token request may take. Mirrors the Google client's own bound; this is a
 * separate constant because that one is module-private to that client. */
export const TOKEN_TIMEOUT_MS = 20_000

export interface ExchangeTokenOptions {
  readonly tokenEndpoint: string
  readonly code: string
  readonly redirectUri: string
  readonly codeVerifier: string
  readonly clientId: string
  /** Null for a public client: the discovery document offered `none`, and PKCE alone protects
   * the exchange. Omitted from the request body rather than sent empty. */
  readonly clientSecret: string | null
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

export interface ExchangedTokens {
  readonly idToken: string
}

interface TokenResponse {
  readonly id_token?: unknown
  readonly error?: unknown
  readonly error_description?: unknown
}

export async function exchangeToken({
  tokenEndpoint,
  code,
  redirectUri,
  codeVerifier,
  clientId,
  clientSecret,
  fetch = globalThis.fetch,
  timeoutMs = TOKEN_TIMEOUT_MS,
}: ExchangeTokenOptions): Promise<ExchangedTokens> {
  if (!tokenEndpoint.startsWith('https://')) {
    // The discovery document is validated to be https before it is ever cached, so this is a
    // defensive check rather than a reachable path: the constraint criterion 15 asks for, stated
    // again at the one place a request is actually made.
    throw new TokenExchangeError('The token endpoint is not https.')
  }

  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: clientId,
  }
  if (clientSecret !== null) body.client_secret = clientSecret

  let response: Response
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new TokenExchangeError(`The token endpoint did not answer within ${timeoutMs}ms.`)
    }
    throw new TokenExchangeError(`The token endpoint could not be reached: ${String(error)}`)
  }

  const payload = (await response.json().catch(() => null)) as TokenResponse | null

  if (!response.ok || typeof payload?.id_token !== 'string') {
    const detail =
      typeof payload?.error_description === 'string'
        ? payload.error_description
        : typeof payload?.error === 'string'
          ? payload.error
          : `${response.status} ${response.statusText}`
    throw new TokenExchangeError(`The provider refused the token exchange: ${detail}`)
  }

  return { idToken: payload.id_token }
}
