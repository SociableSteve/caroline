/**
 * The public origin, the acceptable-origins set and the redirect URI. Spec 13: "The public
 * origin ... is the origin of `server.publicUrl` where it is set, and the origin the process is
 * bound to where it is not." Criterion 34 is fussy about this on purpose: an IPv4-mapped IPv6
 * address is the one case where the string a bind reports and the string a URL parser produces
 * differ, so every derivation here goes through the URL parser rather than through string
 * concatenation, and every comparison parses both sides rather than matching strings.
 */
import type { Config } from '../config/schema.js'
import { loopbackHosts } from './boundary.js'

/** An IPv6 literal needs brackets to be a valid URL host; anything else is used as it is. */
function bracketed(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * `http://<host>:<port>`, with the host bracketed where it is an IPv6 literal, produced by
 * setting `URL.hostname` rather than by building the string by hand. That is what makes an
 * IPv4-mapped address come out normalised the way WHATWG parsing normalises it, which criterion
 * 34 requires: `::ffff:127.0.0.1` yields the same origin as `[::ffff:7f00:1]`, not the literal
 * string it was configured with.
 */
export function originFromHostPort(scheme: 'http' | 'https', host: string, port: number): string {
  const url = new URL(`${scheme}://placeholder`)
  url.hostname = bracketed(host)
  url.port = String(port)
  return url.origin
}

/**
 * The public origin: `server.publicUrl`'s origin where it is set, and the origin of the bind and
 * port where it is not. There is no public origin where `authRequired` is false, but every
 * caller here is already behind that check, so this is unconditional.
 */
export function publicOrigin(config: Config): string {
  if (config.server.publicUrl !== null) return new URL(config.server.publicUrl).origin
  return originFromHostPort('http', config.server.host, config.server.port)
}

export function isPublicOriginHttps(config: Config): boolean {
  return publicOrigin(config).startsWith('https://')
}

/** The redirect URI the authorization request and the token exchange both use. */
export function redirectUri(config: Config): string {
  return `${publicOrigin(config)}/api/auth/callback`
}

/**
 * The loopback set's hostnames, as `URL.hostname` would render each of them. This is not the
 * same set of strings as `loopbackHosts`: WHATWG parsing normalises an IPv4-mapped IPv6 literal,
 * so `::ffff:127.0.0.1` has to be run through the parser to know what a browser's `Origin`
 * header actually says for it (`[::ffff:7f00:1]`) before it can be compared against one.
 * Building this set the same way `originFromHostPort` builds an origin is what keeps the two
 * derivations from disagreeing, which is the failure criterion 34 exists to catch.
 */
export const loopbackHostnames = new Set(
  [...loopbackHosts].map((host) => new URL(`http://${bracketed(host)}`).hostname),
)

/**
 * Whether a browser's `Origin` header is one this install accepts. Where `server.publicUrl` is
 * set, that is exactly its origin. Where it is not, the bind is loopback (nothing else starts),
 * and every loopback origin on any port and either scheme is accepted, which is what makes the
 * dev server and a browser reaching Caroline by a different loopback name than the bind used
 * both work. Spec 13, "The acceptable origins" and criterion 24.
 */
export function isAcceptableOrigin(config: Config, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }

  if (config.server.publicUrl !== null) {
    return parsed.origin === new URL(config.server.publicUrl).origin
  }

  // Compared as `URL.hostname` renders it (brackets kept for an IPv6 literal) against the
  // loopback set rendered the same way, rather than against the unbracketed literal strings
  // `isLoopbackHost` compares `server.host` against: that config value is never URL-parsed, so
  // it is never normalised, and using it here would refuse the normalised form an IPv4-mapped
  // bind's own origin actually parses to.
  return loopbackHostnames.has(parsed.hostname)
}
