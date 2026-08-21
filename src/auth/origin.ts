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
 * Whether a browser's `Origin` header is one this install accepts. Two things are acceptable, and
 * the second is acceptable whatever the configuration says:
 *
 * - The public origin, where `server.publicUrl` is set. Exactly its origin, so scheme and port
 *   included: a browser writes an `Origin` from the address it loaded the page from, and that is
 *   the one this install told the world it is at.
 * - Any loopback origin, on any port and either scheme. Where there is no public URL this is the
 *   whole of the rule, and it has to be, because the bind string is not privileged: the Vite dev
 *   server runs on a port of its own and a browser may reach Caroline by a different loopback
 *   name than the bind used. Where there is a public URL it is accepted beside it rather than
 *   instead of it, for the reason `isAcceptableHost` gives below: the MCP endpoint accepts a
 *   loopback `Origin` and nothing else (spec 12, criterion 9), so a gate refusing every loopback
 *   origin on an install naming a public URL left the two checks unsatisfiable together and that
 *   endpoint permanently unreachable, and `server.publicUrl: "http://127.0.0.1:5123"` (which the
 *   startup guards permit) refused the SPA's own writes as soon as the browser reached it as
 *   `localhost`. What it concedes is a page served by other software on the user's own machine,
 *   which is the thing spec 09 already says a loopback bind was never a boundary against.
 *
 * Spec 13, "The acceptable origins" and criterion 24.
 */
export function isAcceptableOrigin(config: Config, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }

  // Compared as `URL.hostname` renders it (brackets kept for an IPv6 literal) against the
  // loopback set rendered the same way, rather than against the unbracketed literal strings
  // `isLoopbackHost` compares `server.host` against: that config value is never URL-parsed, so
  // it is never normalised, and using it here would refuse the normalised form an IPv4-mapped
  // bind's own origin actually parses to.
  if (loopbackHostnames.has(parsed.hostname)) return true

  if (config.server.publicUrl !== null) {
    return parsed.origin === new URL(config.server.publicUrl).origin
  }

  return false
}

/**
 * Parses a `Host` header into the authority a URL parser would read it as, or null where it is
 * not one. A `Host` header is `host[:port]` and nothing else, so anything carrying a path, a
 * query, a fragment, userinfo or whitespace is refused rather than parsed: `new URL()` would
 * happily read `localhost/../evil.example` as the host `localhost`, and a check that accepted
 * that would be accepting a header no client legitimately sends.
 */
function parseHostHeader(value: string): URL | null {
  if (value === '' || /[/\\?#@\s]/.test(value)) return null
  try {
    return new URL(`http://${value}`)
  } catch {
    return null
  }
}

/**
 * Whether the `Host` header a request carries is one this install answers to. Spec 09's
 * network-posture section: loopback is not a boundary against other software on the machine, and
 * a name somebody else controls can be made to resolve to `127.0.0.1`, at which point a page in
 * the user's own browser is same-origin with the API. The name in the `Host` header is the one
 * thing that attack cannot forge, because the browser writes it from the address bar, so
 * checking it is what makes the loopback bind mean what spec 09 says it means.
 *
 * The rule is `isAcceptableOrigin`'s, asked of an authority rather than of an origin, and it is
 * deliberately the same rule rather than a second one: the public URL's host where one is set, and
 * a loopback name in either case. A missing header is refused: an HTTP/1.0 request may omit it,
 * and there is then no address for the request to have been addressed to.
 *
 * Two things this compares and two it does not, and the reasoning is the same one twice over,
 * because a rebinding attacker forges DNS and cannot forge this header at all. Their page sends
 * the name in the address bar, which is a name they own, never a loopback one and never this
 * install's own.
 *
 * - The hostname is compared. That is the whole of the check, and it is the part the attack
 *   cannot get past.
 * - The port is not. `proxy_set_header Host $host;` is the standard nginx recipe and forwards a
 *   bare hostname with no port at all, so demanding the public URL's port refused every request
 *   on an install whose public URL names one, and a rebinding attempt was never going to be
 *   caught by the port when the hostname already catches it.
 * - The loopback set is accepted beside the public host rather than instead of it. Refusing it
 *   cost a supported configuration outright: `mcp.enabled` is constrained by the bind and not by
 *   `server.publicUrl`, so an install with both registers `POST /api/mcp`, and that route
 *   requires a loopback `Host` of its own (spec 12, criterion 6). Demanding the public host here
 *   and a loopback one there is unsatisfiable, and the endpoint answered 403 to everything. A
 *   per-route exemption would have fixed that by reintroducing exactly the path-based reasoning
 *   the encoded-path bypass came from, so the rule is uniform instead. It also covers
 *   `server.publicUrl: "http://127.0.0.1:5123"`, which the startup guards permit and which a
 *   browser reaches as `localhost:5123`.
 * - The scheme is not compared, because a `Host` header carries none.
 *
 * What a routable install concedes by this is a remote caller sending `Host: localhost`, which
 * reaches the session check and, on a write, the `Origin` check, exactly as any other request
 * does.
 */
export function isAcceptableHost(config: Config, host: string | undefined): boolean {
  if (host === undefined) return false

  const parsed = parseHostHeader(host)
  if (parsed === null) return false

  if (loopbackHostnames.has(parsed.hostname)) return true

  if (config.server.publicUrl !== null) {
    return parsed.hostname === new URL(config.server.publicUrl).hostname
  }

  return false
}
