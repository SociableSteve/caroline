/**
 * The path as the router read it, rather than as the caller wrote it. Spec 13, "The boundary is
 * decided by the route that matched": Fastify decodes percent-escapes before it matches, so
 * `/%61pi/tasks` and `/api/tasks` reach the same handler, and any decision made on the undecoded
 * string disagrees with the decision the router made. That disagreement was a real bypass in the
 * auth gate, and it is the same disagreement wherever else a raw URL is read, so the derivation
 * lives here once rather than in each of them.
 *
 * Kept in a module of its own rather than beside either caller: `auth-gate.ts` imports `apiError`
 * from `errors.ts`, so a helper in either of those files would be an import cycle for the other.
 */

function pathnameOf(requestUrl: string): string {
  const queryIndex = requestUrl.indexOf('?')
  return queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex)
}

/**
 * The decoded pathname of a request URL. A malformed escape is not decodable at all, and the
 * undecoded string is then the closest thing to the truth there is: `decodeURIComponent` throwing
 * must not become a 500 out of a hook or an error handler.
 */
export function decodedPathname(requestUrl: string): string {
  const pathname = pathnameOf(requestUrl)
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}
