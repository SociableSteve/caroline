/**
 * Redirect URI acceptance and matching. Spec 12, criterion 30: a redirect URI on a loopback host
 * is matched without regard to its port, so a native client's ephemeral callback port works, and
 * a redirect URI that is neither loopback nor `https` is refused. RFC 8252 sections 7.3 and 8.3
 * are the sanction for the loopback `http` case; nothing else gets one.
 */
import { isLoopbackHost, stripHostnameBrackets } from '../../auth/boundary.js'

function parse(uri: string): URL | null {
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && isLoopbackHost(stripHostnameBrackets(url.hostname))
}

/** Whether a redirect URI is a shape Caroline will ever register or redirect to at all. */
export function isAcceptableRedirectUri(uri: string): boolean {
  const url = parse(uri)
  if (url === null) return false
  return url.protocol === 'https:' || isLoopbackHttp(url)
}

/**
 * Whether `presented` is the same redirect URI as `registered`, ignoring the port when both are
 * loopback `http`: a native client declares `http://127.0.0.1/callback` in its metadata and
 * actually redirects to whatever ephemeral port it bound this run, and a server matching the
 * port exactly would refuse every client of that shape.
 */
export function redirectUriMatches(presented: string, registered: string): boolean {
  const presentedUrl = parse(presented)
  const registeredUrl = parse(registered)
  if (presentedUrl === null || registeredUrl === null) return false

  if (isLoopbackHttp(presentedUrl) && isLoopbackHttp(registeredUrl)) {
    return (
      stripHostnameBrackets(presentedUrl.hostname) ===
        stripHostnameBrackets(registeredUrl.hostname) &&
      presentedUrl.pathname === registeredUrl.pathname &&
      presentedUrl.search === registeredUrl.search
    )
  }

  return presented === registered
}

/** Whether `uri` matches any of a client's declared redirect URIs, port-agnostically for loopback. */
export function isRegisteredRedirectUri(uri: string, registered: readonly string[]): boolean {
  return registered.some((candidate) => redirectUriMatches(uri, candidate))
}
