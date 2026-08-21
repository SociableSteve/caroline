import type { FastifyError, FastifyInstance } from 'fastify'
import { redactSecrets } from '../config/redact.js'
import type { Config } from '../config/schema.js'
import { decodedPathname } from './request-path.js'

/** The one error shape the API uses: `{ error: { code, message, details? } }`. Spec 08. */
export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export function apiError(code: string, message: string, details?: unknown): ApiError {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } }
}

function codeForStatus(status: number): string {
  if (status === 400) return 'bad_request'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status < 500) return 'bad_request'
  return 'internal_error'
}

/**
 * Registers the shared 404 and error handlers. Every message is scrubbed of configured
 * secrets on the way out, because upstream libraries put tokens in their error text.
 */
export interface ErrorHandlingOptions {
  /** When the built SPA is present, non-API paths serve the shell so the client can route. */
  spaFallback: boolean
}

/**
 * Whether an unmatched request was addressed to the API, decided on the decoded path rather than
 * on the URL the caller wrote. Spec 13, "The boundary is decided by the route that matched", which
 * is about the auth gate and is the same reading wherever a raw URL is consulted: Fastify decodes
 * percent-escapes before matching, so `GET /%61pi/no-such-route` is an API path, and a fallback
 * comparing the raw string saw one beginning `/%61`, called it a client-side route and served the
 * SPA shell with a 200 where the caller should have had a JSON 404. Nothing was exposed by that,
 * only misreported, but it is the same class of defect and the same shape of fix.
 *
 * `/api` on its own counts, and `/apiary` does not: a client-side route is free to be named
 * anything, and only a path that is `/api` or sits under it is one the API would have answered.
 * The auth gate draws its own line one character wider (any decoded path beginning `/api`) because
 * it is deciding whether to require a credential and errs towards requiring one; here the decision
 * is only which of two 404-ish answers to give, so the narrower reading is the right one.
 */
function addressesTheApi(requestUrl: string): boolean {
  const pathname = decodedPathname(requestUrl)
  return pathname === '/api' || pathname.startsWith('/api/')
}

export function registerErrorHandling(
  app: FastifyInstance,
  config: Config,
  { spaFallback }: ErrorHandlingOptions,
): void {
  app.setNotFoundHandler((request, reply) => {
    if (spaFallback && !addressesTheApi(request.url)) {
      return reply.sendFile('index.html')
    }
    // The URL is not echoed. Every byte of it is chosen by the caller, so reflecting it
    // puts caller-supplied bytes into a response body in whatever encoding the caller
    // chose: the same reason the request logger records the matched route instead. The
    // caller knows the URL it sent, and the status and code carry the rest.
    return reply.status(404).send(apiError('not_found', `Route ${request.method} not found`))
  })

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.validation ? 400 : (error.statusCode ?? 500)
    const code = codeForStatus(status)
    const message =
      status >= 500
        ? 'Internal server error'
        : redactSecrets(error.message, config) || 'Request failed'

    if (status >= 500) {
      request.log.error({ err: error }, 'request failed')
    }

    reply.status(status).send(apiError(code, message))
  })
}
