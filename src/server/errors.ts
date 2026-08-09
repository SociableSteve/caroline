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
    return reply
      .status(404)
      .send(
        apiError(
          'not_found',
          `Route ${request.method} ${redactSecrets(request.url, config)} not found`,
        ),
      )
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
