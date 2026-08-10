import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Config } from '../../config/schema.js'
import { redirectUriFor, type GoogleAuth } from '../../connectors/google/auth.js'
import { GoogleAuthError } from '../../connectors/google/oauth.js'
import { apiError } from '../errors.js'
import {
  googleCallbackQuerySchema,
  googleConnectResponseSchema,
  googleStatusResponseSchema,
} from '../schemas.js'

export interface IntegrationRouteContext {
  readonly config: Config
  readonly google: GoogleAuth
}

function notConfigured(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send(apiError('not_configured', message))
}

/**
 * Connecting the Google account: the desktop OAuth flow, driven from Settings. Spec 09.
 *
 * The redirect comes back to this server, because a loopback redirect is the one address a local
 * tool can offer and Caroline is already listening on it. Nothing from the callback's query string
 * is echoed or logged: every byte of it is the caller's, and one of those bytes is an
 * authorisation code.
 */
export function registerIntegrationRoutes(
  app: FastifyInstance,
  { config, google }: IntegrationRouteContext,
): void {
  app.get(
    '/api/integrations/google',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {} },
        response: { 200: googleStatusResponseSchema },
      },
    },
    async () => ({ ...google.status(), redirectUri: redirectUriFor(config) }),
  )

  app.post(
    '/api/integrations/google/connect',
    {
      schema: {
        body: { type: ['object', 'null'], additionalProperties: false, properties: {} },
        response: { 200: googleConnectResponseSchema },
      },
    },
    async (_request, reply) => {
      try {
        return { url: google.begin().url }
      } catch (error) {
        // Nothing to consent to yet: no client id, or no secret in the environment.
        if (error instanceof GoogleAuthError) return notConfigured(reply, error.message)
        throw error
      }
    },
  )

  /**
   * Where Google sends the browser. It answers with a redirect into the settings screen rather than
   * with JSON, because what is looking at it is a browser tab the user was sent away in, and it
   * says which of the two things happened without repeating anything the query string said.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/integrations/google/callback',
    { schema: { querystring: googleCallbackQuerySchema } },
    async (request, reply) => {
      const { code, state, error } = request.query

      if (error !== undefined) {
        // Google's own error word, which is a fixed vocabulary rather than caller-chosen text.
        return reply.redirect(`/#/settings?google=refused&reason=${encodeURIComponent(error)}`)
      }

      if (code === undefined || state === undefined) {
        return reply.redirect('/#/settings?google=incomplete')
      }

      try {
        await google.complete(code, state)
      } catch (failure) {
        if (failure instanceof GoogleAuthError) {
          app.log.warn('Completing the Google authorisation failed')
          return reply.redirect('/#/settings?google=failed')
        }
        throw failure
      }

      return reply.redirect('/#/settings?google=connected')
    },
  )

  app.delete(
    '/api/integrations/google',
    { schema: { response: { 204: { type: 'null' } } } },
    async (_request, reply) => {
      google.disconnect()
      return reply.status(204).send()
    },
  )
}
