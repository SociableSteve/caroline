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
 * criterion 24 asks for, which is a separate mechanism applying to the same route list on a
 * different condition.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { readCookie, sessionCookieName } from '../auth/cookie.js'
import { isAcceptableOrigin, isPublicOriginHttps } from '../auth/origin.js'
import { apiError } from './errors.js'
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
])

function pathnameOf(request: FastifyRequest): string {
  const queryIndex = request.url.indexOf('?')
  return queryIndex === -1 ? request.url : request.url.slice(0, queryIndex)
}

/** Everything outside `/api`, and the three public auth routes. Asserted by name, spec 13. */
function isExemptFromSessionCheck(method: string, pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return true
  return EXEMPT_AUTH_ROUTES.has(`${method} ${pathname}`)
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
 * Registers the boundary hook. Where `authRequired` is false, the only thing checked is the
 * forwarded-header refusal, which is the one signal that surface still gets: no request is
 * refused for want of a session there, on any route (spec 13 criterion 2), and no `Origin` check
 * runs there either, because there is no public origin and no session cookie to protect (spec
 * 13, "Why there is no CSRF token").
 *
 * Where `authRequired` is true: the `Origin` check runs first, on every non-`GET`/`HEAD` request
 * that carries an `Origin` header, whether or not the route is otherwise exempt (criterion 24);
 * then the session check runs, skipping the three exempt public routes and everything outside
 * `/api` (criterion 1).
 */
export function registerAuthGate(app: FastifyInstance, config: Config, auth: SessionChecker): void {
  const cookieName = sessionCookieName(isPublicOriginHttps(config))

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
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
      }
      return
    }

    const method = request.method
    const pathname = pathnameOf(request)

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

    if (isExemptFromSessionCheck(method, pathname)) return

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
