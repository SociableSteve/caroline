import type { FastifyError, FastifyInstance } from 'fastify'
import { redactSecrets } from '../config/redact.js'
import type { Config } from '../config/schema.js'

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

export function registerErrorHandling(
  app: FastifyInstance,
  config: Config,
  { spaFallback }: ErrorHandlingOptions,
): void {
  app.setNotFoundHandler((request, reply) => {
    if (spaFallback && !request.url.startsWith('/api/')) {
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
