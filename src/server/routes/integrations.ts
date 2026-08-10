import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Config } from '../../config/schema.js'
import { redirectUriFor, type GoogleAuth } from '../../connectors/google/auth.js'
import { GoogleAuthError } from '../../connectors/google/oauth.js'
import { deleteAllCalendarEvents } from '../../db/repositories/calendar-events.js'
import type { Database } from '../../db/index.js'
import { apiError } from '../errors.js'
import {
  googleCallbackQuerySchema,
  googleConnectResponseSchema,
  googleStatusResponseSchema,
} from '../schemas.js'

export interface IntegrationRouteContext {
  readonly config: Config
  readonly database: Database
  readonly google: GoogleAuth
}

function notConfigured(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send(apiError('not_configured', message))
}

/**
 * Connecting the Google account: the desktop OAuth flow, driven from Settings. Spec 09.
 *
 * The redirect comes back to this server, because a loopback redirect is the one address a local
 * tool can offer and Caroline is already listening on it. The authorisation code is neither echoed
 * nor logged: every byte of the query string is the caller's to choose, and that one is a
 * credential. Google's own `error` word is the exception, and it is carried into the redirect as
 * `reason` so the screen can say what went wrong; it comes from a fixed vocabulary, the router
 * reads only `google`, and Settings maps that through a fixed set of sentences rather than
 * rendering either value.
 */
export function registerIntegrationRoutes(
  app: FastifyInstance,
  { config, database, google }: IntegrationRouteContext,
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
   * with JSON, because what is looking at it is a browser tab the user was sent away in.
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

  /**
   * Disconnecting takes the diary with it. An event is not something Caroline was asked to
   * remember, it is a reading of a calendar it can no longer see: leaving the rows behind would
   * have tomorrow's capacity computed from meetings nobody can check, for as long as the
   * database lives. The tasks and sources Gmail and GitHub produced are untouched, because
   * those are work rather than a reading. Spec 09.
   */
  app.delete(
    '/api/integrations/google',
    { schema: { response: { 204: { type: 'null' } } } },
    async (_request, reply) => {
      google.disconnect()
      deleteAllCalendarEvents(database)
      return reply.status(204).send()
    },
  )
}
