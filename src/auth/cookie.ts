/**
 * The session cookie's name and its `Set-Cookie` string. No cookie library: the session is one
 * opaque value, and Fastify hands headers back exactly as it is given them. Spec 13.
 */

/**
 * `__Host-` whenever the public origin is `https`, and a plain name otherwise, because a
 * browser refuses a `__Host-` cookie without `Secure` and a loopback `http` deployment would
 * simply stop working if the name never changed with it.
 */
export function sessionCookieName(publicOriginIsHttps: boolean): string {
  return publicOriginIsHttps ? '__Host-caroline_session' : 'caroline_session'
}

export interface SetCookieOptions {
  readonly name: string
  readonly value: string
  readonly maxAgeSeconds: number
  readonly secure: boolean
}

/**
 * `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, ever: the cookie only ever needs to reach
 * this one host. `Secure` only where the public origin is `https`, per `sessionCookieName`'s own
 * rule, so the two never disagree with each other.
 */
export function setCookieHeader({ name, value, maxAgeSeconds, secure }: SetCookieOptions): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearCookieHeader(name: string, secure: boolean): string {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Parses the incoming `Cookie` header for one name. Fastify does not decode it for us here
 * because there is no cookie plugin registered; the value is opaque base64url anyway. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null

  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals === -1) continue
    const key = part.slice(0, equals).trim()
    if (key === name) return part.slice(equals + 1).trim()
  }

  return null
}
