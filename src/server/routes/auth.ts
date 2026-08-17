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
    { schema: { querystring: authCallbackQuerySchema } },
    async (request, reply) => {
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
        // The body names no address (spec 13, "Who is allowed in"): every message built above is
        // already free of the caller-attested email or subject.
        return reply.status(status).send(apiError(code, message))
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
