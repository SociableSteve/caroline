/**
 * Where `authRequired` is derived. Spec 13: "There is exactly one derived fact, computed once
 * at startup from the configuration: `authRequired`. Every check reads it." Keeping the rule in
 * one function is the whole point: a rule inferred in several places is a rule that is wrong in
 * one of them.
 */

/**
 * The loopback set, named here once so `src/config/load.ts`'s startup guards and the request-time
 * boundary agree on exactly the same hosts. `0.0.0.0` and `::` are deliberately not in it: a
 * wildcard bind accepts connections from the network, so a request that happens to arrive over
 * loopback on such a bind still requires a session.
 */
export const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'])

export function isLoopbackHost(host: string): boolean {
  return loopbackHosts.has(host)
}

export interface BoundaryInputs {
  /** The bind address, `server.host`. */
  readonly host: string
  /** `server.publicUrl`, or null where it is unset. */
  readonly publicUrl: string | null
  /** `auth.mode`. */
  readonly mode: 'auto' | 'required'
}

/**
 * `authRequired` is true when any of: the bind is not loopback, `server.publicUrl` is set, or
 * `auth.mode` is `"required"`. Spec 13, "Where the boundary decision is made".
 */
export function computeAuthRequired({ host, publicUrl, mode }: BoundaryInputs): boolean {
  return !isLoopbackHost(host) || publicUrl !== null || mode === 'required'
}
