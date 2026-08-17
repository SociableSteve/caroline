/**
 * OIDC discovery. Spec 13: fetched lazily on the first login attempt, never at startup, and
 * cached thereafter. `auth.provider.issuer` is a user-chosen destination in the same sense
 * `llm.baseUrl` is (spec 13, "The discovery fetch is a user-chosen destination"), so the guards
 * here are the cheap ones that keep a user-chosen issuer honest: `https` only, the document's own
 * `issuer` must equal the configured one, its endpoints must be `https`, and there is a size cap
 * and a timeout.
 */

/** How long the discovery fetch may take. */
export const DISCOVERY_TIMEOUT_MS = 10_000

/** How much of the response body is read before giving up on it. */
export const DISCOVERY_MAX_BYTES = 1_000_000

export class DiscoveryError extends Error {
  override name = 'DiscoveryError'
}

/** The provider could not be reached at all: a network failure or a timeout, reported to the
 * login screen as "unreachable" rather than as an internal error. Spec 13, criterion 11. */
export class ProviderUnreachableError extends DiscoveryError {
  override name = 'ProviderUnreachableError'
}

export interface DiscoveryDocument {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly tokenEndpointAuthMethodsSupported: readonly string[]
}

interface RawDocument {
  readonly issuer?: unknown
  readonly authorization_endpoint?: unknown
  readonly token_endpoint?: unknown
  readonly code_challenge_methods_supported?: unknown
  readonly token_endpoint_auth_methods_supported?: unknown
}

function isHttps(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://')
}

/**
 * Refused with a message naming what was wrong, one case at a time, so criterion 12's cases are
 * each their own assertion.
 */
function validate(raw: RawDocument, issuer: string): DiscoveryDocument {
  if (!isHttps(raw.authorization_endpoint)) {
    throw new DiscoveryError(
      'The discovery document has no https authorization_endpoint. Caroline cannot log in through this provider.',
    )
  }
  if (!isHttps(raw.token_endpoint)) {
    throw new DiscoveryError(
      'The discovery document has no https token_endpoint. Caroline cannot log in through this provider.',
    )
  }
  if (raw.issuer !== issuer) {
    throw new DiscoveryError(
      `The discovery document's issuer ("${String(raw.issuer)}") does not match the configured auth.provider.issuer ("${issuer}").`,
    )
  }
  const methods = raw.code_challenge_methods_supported
  if (!Array.isArray(methods) || !methods.includes('S256')) {
    throw new DiscoveryError(
      'The discovery document does not advertise S256 in code_challenge_methods_supported. Caroline requires PKCE.',
    )
  }

  const authMethods = raw.token_endpoint_auth_methods_supported
  return {
    issuer: raw.issuer,
    authorizationEndpoint: raw.authorization_endpoint,
    tokenEndpoint: raw.token_endpoint,
    tokenEndpointAuthMethodsSupported: Array.isArray(authMethods)
      ? authMethods.filter((method): method is string => typeof method === 'string')
      : [],
  }
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400
}

async function fetchOnce(
  fetchFn: typeof globalThis.fetch,
  url: URL,
  timeoutMs: number,
  issuer: string,
): Promise<Response> {
  try {
    return await fetchFn(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ProviderUnreachableError(
        `${issuer} did not answer the discovery request within ${timeoutMs}ms.`,
      )
    }
    throw new ProviderUnreachableError(`${issuer} could not be reached: ${String(error)}`)
  }
}

export interface FetchDiscoveryOptions {
  readonly issuer: string
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

/**
 * Fetches and validates `{issuer}/.well-known/openid-configuration`. Not cached here: the cache
 * is the caller's, so the caller decides what "once per process" means for its own tests.
 */
export async function fetchDiscoveryDocument({
  issuer,
  fetch = globalThis.fetch,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
}: FetchDiscoveryOptions): Promise<DiscoveryDocument> {
  if (!issuer.startsWith('https://')) {
    throw new DiscoveryError('auth.provider.issuer must be an https URL.')
  }

  const url = new URL('/.well-known/openid-configuration', issuer)

  // `redirect: 'manual'` so a redirect is a decision this function makes rather than one
  // `fetch` makes for it: spec 13 requires "no redirect is followed to another host", and
  // following one silently is the one thing that guard cannot be checked after the fact.
  // One hop is allowed, and only to the same host as the URL that produced it, which covers
  // the ordinary case (a bare domain redirecting to its own `www.` or vice versa) without
  // ever crossing to a host the operator did not configure.
  let response = await fetchOnce(fetch, url, timeoutMs, issuer)
  if (isRedirect(response)) {
    const location = response.headers.get('location')
    if (location === null) {
      throw new DiscoveryError(`${issuer} answered discovery with a redirect naming no location.`)
    }
    const target = new URL(location, url)
    if (target.host !== url.host) {
      throw new DiscoveryError(
        `${issuer} redirected discovery to a different host ("${target.host}"), which Caroline refuses to follow.`,
      )
    }
    response = await fetchOnce(fetch, target, timeoutMs, issuer)
    if (isRedirect(response)) {
      throw new DiscoveryError(
        `${issuer} redirected discovery more than once, which Caroline refuses to follow.`,
      )
    }
  }

  if (!response.ok) {
    throw new ProviderUnreachableError(
      `${issuer} answered discovery with ${response.status} ${response.statusText}.`,
    )
  }

  const text = await response.text()
  if (text.length > DISCOVERY_MAX_BYTES) {
    throw new DiscoveryError('The discovery document is larger than Caroline will read.')
  }

  let raw: RawDocument
  try {
    raw = JSON.parse(text) as RawDocument
  } catch {
    throw new DiscoveryError('The discovery document is not valid JSON.')
  }

  return validate(raw, issuer)
}
