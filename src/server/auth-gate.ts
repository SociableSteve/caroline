/**
 * The one check over the whole route list. Spec 13, "One check over the whole route list": a
 * single `onRequest` hook, registered beside `registerRoutes` in `buildServer`, so the boundary
 * is one function rather than a rule remembered per route. Kept under `src/server/`, beside
 * `app.ts`, because criterion 6's source inspection for the forwarded-header names, and for the
 * Fastify proxy-trust option `buildServer` sets explicitly, looks there.
 *
 * Slice 2 extends slice 1's placeholder with the real mechanism: a session check that reads the
 * cookie, hashes it, looks it up and compares with `crypto.timingSafeEqual` (all in
 * `src/db/repositories/sessions.ts`, through `AuthService.checkSession`), and the `Origin` check
 * criterion 24 asks for, which is a separate mechanism applying to the same route list.
 *
 * The security review of 2026-08-21 added a `Host` check beside them and made the `Origin` check
 * unconditional (spec 09, criteria 21 and 22), and moved the session check's exemption onto the
 * matched route template rather than the request's own path (spec 13, "The boundary is decided by
 * the route that matched"). What is left conditional on `authRequired` is the session check
 * itself, and the forwarded-header refusal, which is the check the unauthenticated surface gets
 * instead of one.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { readCookie, sessionCookieName } from '../auth/cookie.js'
import { isAcceptableHost, isAcceptableOrigin, isPublicOriginHttps } from '../auth/origin.js'
import { apiError } from './errors.js'
import { decodedPathname } from './request-path.js'
import type { Config } from '../config/schema.js'

/**
 * The three public auth routes, by method and path. A login flow cannot require a session, so
 * these are exempt from the session check; everything outside `/api` (the SPA shell and its
 * assets) is exempt too. Not exempt from the `Origin` check below, which is a separate
 * mechanism: `POST /api/auth/login` and `POST /api/auth/logout` are writes like any other.
 */
export const EXEMPT_AUTH_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/auth/status',
  'POST /api/auth/login',
  'GET /api/auth/callback',
  /**
   * Spec 12: the MCP endpoint checks its own credential, a bearer token Caroline's own
   * authorisation server issued (validated in `src/mcp/route.ts` via `validateAccessToken`,
   * `src/mcp/oauth/service.js`), which is not the browser's session and answers to a caller that
   * has no session cookie to present in the first place. Exempt from the session check for that
   * reason, and only from it: the `Origin` check below still runs, and the endpoint is
   * unregistered at all unless `mcp.enabled` is true and the bind is loopback (spec 12, criteria
   * 5 and 6), so this line grants nothing where that has not already been decided. Spec 12
   * criterion 33: nothing about the API's own credential changes here.
   */
  'POST /api/mcp',
  /**
   * Spec 12, slice 3: the token endpoint is reached by an MCP client's own code, which holds no
   * session cookie either, exactly as `POST /api/mcp` does not. `GET /api/mcp/authorize` and the
   * two `/api/mcp/oauth/*` routes beside it are deliberately not exempt: they are hit by a
   * browser, and the consent screen they lead to is exactly the surface a login already protects
   * where one is configured. Exempting the token endpoint grants nothing about the MCP endpoint
   * itself, which stays unregistered at all unless `mcp.enabled` is true and the bind is
   * loopback (criteria 5 and 6).
   */
  'POST /api/mcp/token',
])

/**
 * Whether this request is exempt from the session check, decided on the route template the
 * router matched rather than on the path the caller sent. Spec 13, "The boundary is decided by
 * the route that matched": the two differ, because Fastify decodes percent-escapes before it
 * matches, so `/%61pi/tasks` is served by the `/api/tasks` handler while its raw path does not
 * begin with `/api/` at all. A check written against the raw path therefore exempted every route
 * in the API from the session check to any caller who encoded one character of it, which is what
 * spec 09 criterion 20 now asserts against.
 *
 * Three cases, and the third is the one that has to fail closed:
 *
 * - A template under `/api/`: a session is required unless the template is in
 *   `EXEMPT_AUTH_ROUTES`. Matched against the template, so `GET /api/auth/status` still names
 *   itself the way that set spells it.
 * - Any other template, which in practice is `@fastify/static`'s `/*`: exempt, as the SPA shell
 *   and its assets have always been.
 * - No template, meaning the request matched no route. There is nothing to consult, so the
 *   decoded path decides, and it decides towards refusal: anything under `/api` is refused, and
 *   everything else is exempt so that the shell and the login screen stay reachable without a
 *   session. `/api` rather than `/api/`, because a request that matched nothing has no shape this
 *   can rely on, and the price of that is a cosmetic one: on a checkout with no built SPA,
 *   `/apiary` is refused with a 401 where `/dashboard` gets a 404, an odd-looking status for a path
 *   no route serves. Both are kept, because this branch's whole job is to be wrong in the safe
 *   direction and a configuration with no shell has nothing better to answer either path with.
 *
 *   This branch is also narrower than it looks. `@fastify/static` registers `/*`, so with the SPA
 *   built an unmatched `GET` matches that template and takes the bullet above; what is left here is
 *   a method `@fastify/static` does not register, and a checkout with no built SPA. Not trimmed to
 *   those, because which routes a configuration registers is not something this should rest on.
 *   Spec 09, criterion 20, is written to claim only what that leaves it asserting.
 *
 * Exported so the suite can assert the two failures no request can drive through the router: a
 * malformed escape, which Fastify refuses itself before any hook runs, and an unmatched path.
 */
export function isExemptFromSessionCheck(
  method: string,
  routeTemplate: string | undefined,
  requestUrl: string,
): boolean {
  if (routeTemplate === undefined) return !decodedPathname(requestUrl).startsWith('/api')
  if (!routeTemplate.startsWith('/api/')) return true
  return EXEMPT_AUTH_ROUTES.has(`${method} ${routeTemplate}`)
}

/** What the gate needs from the auth service: just the session lookup, so this module does not
 * have to know how a session is stored to check one. */
export interface SessionChecker {
  checkSession(sessionValue: string): { readonly id: string } | null
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The session this request was authenticated with, where `authRequired` is true and the
     * request passed the check. Read by the changes and chat routes so a stream they open can
     * be closed by session id if that session is later revoked or expires. Spec 13, criteria
     * 22 and 23.
     */
    sessionId?: string | null
  }
}

/**
 * Registers the boundary hook. Three checks apply to every request whatever the configuration
 * says, and one applies only where a login is configured:
 *
 * - The `Host` check, first, because a request addressed to a name this install does not answer
 *   to should be refused before anything else is decided about it. Unconditional: the hole it
 *   closes is on the default configuration, where the loopback bind is the whole boundary.
 * - The forwarded-header refusal, where `authRequired` is false: the one signal that surface
 *   still gets about a proxy nobody configured (spec 13, criterion 6).
 * - The `Origin` check, on every non-`GET`/`HEAD` request carrying an `Origin` header, whether or
 *   not the route is otherwise exempt (criterion 24), and now whether or not a login is
 *   configured. A body-less `POST` is a simple request, so the CORS preflight requirement that
 *   covers every JSON-body route covers none of them, and a page anywhere could fire one at a
 *   loopback install. Spec 13's "Why there is no CSRF token" argues from the acceptable-origin
 *   set rather than from a login, and that argument holds just as well with no login in play.
 * - The session check, where `authRequired` is true, skipping the exempt public routes and
 *   everything the router matched outside `/api` (criterion 1). No request is refused for want of
 *   a session where `authRequired` is false, on any route (criterion 2).
 */
export function registerAuthGate(app: FastifyInstance, config: Config, auth: SessionChecker): void {
  const cookieName = sessionCookieName(isPublicOriginHttps(config))

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // First, and on every request whether or not a login is configured: the address this request
    // was addressed to. Spec 09's network posture rests on the loopback bind being a boundary,
    // and it is not one against a name somebody else controls that resolves to `127.0.0.1`. The
    // MCP endpoint has checked this since spec 12 for exactly that reason; this is the same check
    // over the rest of the API, by the same loopback set, widened by the public host where
    // `server.publicUrl` names one.
    if (!isAcceptableHost(config, request.headers.host)) {
      // The message names `server.publicUrl` because this check is the one an operator who fronts
      // Caroline with a proxy and has not set it meets first, on every request: the
      // forwarded-header refusal below says the same thing and is never reached, since a proxy
      // rewriting `Host` to the public name is refused here before it gets there. Naming the
      // setting in the message is preferred to reordering the two, because the address a request
      // was addressed to is the first thing to decide about it and nothing else should be decided
      // for a request this install does not answer to.
      await reply
        .status(403)
        .send(
          apiError(
            'forbidden',
            'This request carries a Host this Caroline does not answer to. Set server.publicUrl to the address Caroline is reached at if it is behind a proxy.',
          ),
        )
      return
    }

    if (!config.authRequired) {
      const carriesForwardedHeader =
        request.headers['x-forwarded-for'] !== undefined || request.headers.forwarded !== undefined
      if (carriesForwardedHeader) {
        await reply
          .status(400)
          .send(
            apiError(
              'bad_request',
              'This request carries a forwarded-address header, which is not trusted here. Set server.publicUrl if Caroline is really behind a proxy.',
            ),
          )
        return
      }
    }

    const method = request.method

    if (method !== 'GET' && method !== 'HEAD') {
      const origin = request.headers.origin
      if (origin !== undefined && !isAcceptableOrigin(config, origin)) {
        await reply
          .status(403)
          .send(
            apiError('forbidden', 'This request carries an Origin this Caroline does not accept.'),
          )
        return
      }
    }

    if (!config.authRequired) return

    // `request.routeOptions.url` is the template the router matched, and it is the value
    // `requestSerialiser` in `src/server/log-redaction.ts` already logs a request by, for the
    // related reason that no byte of the caller's own URL may reach a log line. Reused here
    // rather than a second derivation of the same fact.
    if (isExemptFromSessionCheck(method, request.routeOptions.url, request.url)) return

    const cookieValue = readCookie(request.headers.cookie, cookieName)
    const found = cookieValue === null ? null : auth.checkSession(cookieValue)

    if (found === null) {
      await reply
        .status(401)
        .send(apiError('unauthorized', 'This request requires a session, and none was presented.'))
      return
    }

    request.sessionId = found.id
  })
}
