/**
 * Spec 13's four routes. Three of them are public (`GET /api/auth/status`, `POST
 * /api/auth/login`, `GET /api/auth/callback`), exempted from the session check in
 * `auth-gate.ts`; `POST /api/auth/logout` is not, and revokes the session it is called with.
 */
import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../../auth/service.js'
import { AuthFlowError } from '../../auth/service.js'
import {
  clearCookieHeader,
  readCookie,
  sessionCookieName,
  setCookieHeader,
} from '../../auth/cookie.js'
import { DiscoveryError, ProviderUnreachableError } from '../../auth/discovery.js'
import { isPublicOriginHttps } from '../../auth/origin.js'
import type { Config } from '../../config/schema.js'
import { apiError } from '../errors.js'
import {
  authCallbackQuerySchema,
  authLoginBodySchema,
  authLoginResponseSchema,
  authStatusResponseSchema,
} from '../schemas.js'

export interface AuthRouteContext {
  readonly config: Config
  readonly auth: AuthService
}

const DAY_SECONDS = 24 * 60 * 60

/** Everything but the two public login-flow errors becomes a 500, logged, so a bug here reads
 * as a bug rather than as a silently wrong status. */
function statusAndMessage(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof AuthFlowError) {
    return { status: error.status, code: error.code, message: error.message }
  }
  if (error instanceof ProviderUnreachableError) {
    return { status: 502, code: 'provider_unreachable', message: error.message }
  }
  if (error instanceof DiscoveryError) {
    return { status: 400, code: 'bad_request', message: error.message }
  }
  return { status: 500, code: 'internal_error', message: 'The login could not be completed.' }
}

export function registerAuthRoutes(app: FastifyInstance, { config, auth }: AuthRouteContext): void {
  const secure = isPublicOriginHttps(config)
  const cookieName = sessionCookieName(secure)
  const maxAgeSeconds = config.auth.sessionIdleDays * DAY_SECONDS

  app.get(
    '/api/auth/status',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {} },
        response: { 200: authStatusResponseSchema },
      },
    },
    async (request) => {
      const sessionValue = readCookie(request.headers.cookie, cookieName)
      return auth.status(sessionValue)
    },
  )

  app.post<{ Body: { hash?: string } }>(
    '/api/auth/login',
    { schema: { body: authLoginBodySchema, response: { 200: authLoginResponseSchema } } },
    async (request, reply) => {
      try {
        const result = await auth.login(request.body.hash ?? null)
        return result
      } catch (error) {
        const { status, code, message } = statusAndMessage(error)
        if (status >= 500) request.log.error({ err: error }, 'login could not be started')
        return reply.status(status).send(apiError(code, message))
      }
    },
  )

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/callback',
    // `attachValidation` rather than letting a bad querystring (e.g. a duplicated `code`) fall
    // through to the global error handler: that answers JSON, and this route is the same
    // top-level browser navigation as the handler's own refusal paths below, so a validation
    // failure gets the same redirect treatment rather than the raw error body the rest of this
    // handler exists to avoid.
    { schema: { querystring: authCallbackQuerySchema }, attachValidation: true },
    async (request, reply) => {
      if (request.validationError) {
        request.log.warn({ err: request.validationError }, 'callback query failed validation')
        return reply.redirect(`/?login=${encodeURIComponent('bad_request')}`, 302)
      }

      try {
        const result = await auth.callback(request.query)

        reply.header(
          'set-cookie',
          setCookieHeader({ name: cookieName, value: result.cookieValue, maxAgeSeconds, secure }),
        )

        const destination = result.hash === null || result.hash === '' ? '/' : `/#${result.hash}`
        return reply.redirect(destination, 302)
      } catch (error) {
        const { status, code, message } = statusAndMessage(error)
        if (status >= 500) request.log.error({ err: error }, 'login callback failed')
        // Otherwise not >= 500, but still worth keeping: the operator has log access and the
        // browser does not, and the message (unlike the browser-facing code below) can be
        // specific, e.g. naming CAROLINE_AUTH_CLIENT_SECRET and the methods a provider advertised.
        else request.log.warn({ code }, message)

        // This route is always a top-level browser navigation: the provider's redirect lands
        // here directly, never through `fetch`, so a JSON body would render as a bare page of
        // text rather than anything the login screen can show. It redirects into the SPA instead,
        // exactly as `GET /api/integrations/google/callback` already does, naming the failure in
        // `login` rather than in the body: the code is the same fixed vocabulary the JSON error
        // shape already used (`forbidden`, `bad_request`, `provider_unreachable`,
        // `internal_error`), so it names no address either, per spec 13's "Who is allowed in".
        return reply.redirect(`/?login=${encodeURIComponent(code)}`, 302)
      }
    },
  )

  app.post(
    '/api/auth/logout',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } },
    async (request, reply) => {
      const sessionValue = readCookie(request.headers.cookie, cookieName)
      if (sessionValue !== null) auth.logout(sessionValue)

      reply.header('set-cookie', clearCookieHeader(cookieName, secure))
      return reply.status(204).send()
    },
  )
}
