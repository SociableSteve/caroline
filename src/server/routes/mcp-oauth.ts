/**
 * The authorisation code flow for an MCP client: the consent screen and the token endpoint.
 * Spec 12, slice 3; spec 08 names the two paths, `/api/mcp/authorize` and `POST /api/mcp/token`.
 *
 * `GET /api/mcp/authorize` is opened by the client's own system browser, not fetched by the
 * client itself, so its answer is a redirect rather than JSON: either straight back to the
 * client with a code, for a client already approved, or onward to the consent screen on
 * Settings for one that is not (spec 12, criterion 31). The two `/api/mcp/oauth/*` routes beside
 * it are what that screen calls: reading what it is being asked to show, and posting the
 * decision.
 *
 * `POST /api/mcp/token` answers in the OAuth token endpoint's own error shape,
 * `{ error, error_description }`, rather than the API's `{ error: { code, message } }`: a
 * conformant OAuth client parses the first and not the second, and this route is not the one
 * spec 08 criterion 37 names as the JSON-RPC exception, so it earns its own departure from the
 * standard shape by the same reasoning that criterion states rather than by extending it.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Config } from '../../config/schema.js'
import type { Database } from '../../db/connection.js'
import {
  beginAuthorization,
  decideAuthorization,
  exchangeToken,
  getConsentView,
  listApprovedClients,
  McpOauthError,
  revokeClient,
  type AuthorizeParams,
} from '../../mcp/oauth/service.js'
import type { fetchClientMetadata } from '../../mcp/oauth/client-metadata.js'

export interface McpOauthRouteContext {
  readonly config: Config
  readonly database: Database
  readonly now: () => number
  /** Injected in tests so the client metadata fetch never reaches a real network. */
  readonly fetchClientMetadata?: typeof fetchClientMetadata
}

function oauthError(
  reply: FastifyReply,
  status: number,
  code: string,
  description: string,
): FastifyReply {
  return reply.status(status).send({ error: code, error_description: description })
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const authorizeQuerystringSchema = {
  type: 'object',
  // Spec 12 defines no scopes for this slice, so a spec-conformant client need not send `scope`,
  // but real-world OAuth clients often send one anyway (PKCE libraries default to requesting
  // one). A request carrying it is not a bad request: matches authCallbackQuerySchema's handling
  // of Google's extra callback params, fixed for the same reason in PR #26. Extra params are
  // ignored rather than rejected.
  additionalProperties: true,
  properties: {
    response_type: { type: 'string' },
    client_id: { type: 'string' },
    redirect_uri: { type: 'string' },
    code_challenge: { type: 'string' },
    code_challenge_method: { type: 'string' },
    state: { type: 'string' },
    resource: { type: 'string' },
  },
} as const

export function registerMcpOauthRoutes(
  app: FastifyInstance,
  { config, database, now, fetchClientMetadata }: McpOauthRouteContext,
): void {
  if (!config.mcp.enabled) return

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
      } catch (error) {
        done(error as Error, undefined)
      }
    },
  )

  app.get<{
    Querystring: {
      response_type?: string
      client_id?: string
      redirect_uri?: string
      code_challenge?: string
      code_challenge_method?: string
      state?: string
      resource?: string
    }
  }>(
    '/api/mcp/authorize',
    { schema: { querystring: authorizeQuerystringSchema } },
    async (request, reply) => {
      const params: AuthorizeParams = {
        responseType: request.query.response_type,
        clientId: request.query.client_id,
        redirectUri: request.query.redirect_uri,
        codeChallenge: request.query.code_challenge,
        codeChallengeMethod: request.query.code_challenge_method,
        state: request.query.state,
        resource: request.query.resource,
      }

      try {
        const result = await beginAuthorization(
          {
            config,
            database,
            now,
            ...(fetchClientMetadata === undefined ? {} : { fetchClientMetadata }),
          },
          params,
        )
        return result.kind === 'redirect'
          ? reply.redirect(result.url)
          : reply.redirect(`/#/settings?mcpRequest=${encodeURIComponent(result.requestId)}`)
      } catch (error) {
        if (error instanceof McpOauthError) {
          return reply
            .status(error.status)
            .send({ error: error.code, error_description: error.message })
        }
        throw error
      }
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/mcp/oauth/consent/:id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const view = getConsentView(database, request.params.id, now())
      if (view === null) {
        return reply.status(404).send({
          error: 'not_found',
          error_description: 'That authorisation request has expired or was already decided.',
        })
      }
      return view
    },
  )

  app.post<{ Params: { id: string }; Body: { approve?: boolean } }>(
    '/api/mcp/oauth/consent/:id/decide',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { approve: { type: 'boolean' } },
          required: ['approve'],
        },
      },
    },
    async (request, reply) => {
      try {
        const redirectTo = decideAuthorization(
          { config, database, now },
          request.params.id,
          request.body.approve === true,
        )
        return { redirectTo }
      } catch (error) {
        if (error instanceof McpOauthError) {
          return reply
            .status(error.status)
            .send({ error: error.code, error_description: error.message })
        }
        throw error
      }
    },
  )

  app.post(
    '/api/mcp/token',
    // A permissive schema, in the same shape `POST /api/mcp` uses: this route validates its own
    // body against the grant it names, in the token endpoint's own error shape, rather than
    // through Fastify's schema machinery, which would answer a violation in the API's envelope.
    { schema: { body: { type: 'object' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>
      const grantType = stringField(body.grant_type)

      try {
        if (grantType === 'authorization_code') {
          const code = stringField(body.code)
          const redirectUri = stringField(body.redirect_uri)
          const clientId = stringField(body.client_id)
          const codeVerifier = stringField(body.code_verifier)
          if (
            code === undefined ||
            redirectUri === undefined ||
            clientId === undefined ||
            codeVerifier === undefined
          ) {
            return oauthError(
              reply,
              400,
              'invalid_request',
              'code, redirect_uri, client_id and code_verifier are all required.',
            )
          }

          const tokens = exchangeToken(
            { config, database, now },
            { grantType: 'authorization_code', code, redirectUri, clientId, codeVerifier },
          )
          return tokens
        }

        if (grantType === 'refresh_token') {
          const refreshToken = stringField(body.refresh_token)
          if (refreshToken === undefined) {
            return oauthError(reply, 400, 'invalid_request', 'refresh_token is required.')
          }

          const tokens = exchangeToken(
            { config, database, now },
            { grantType: 'refresh_token', refreshToken, clientId: stringField(body.client_id) },
          )
          return tokens
        }

        return oauthError(
          reply,
          400,
          'unsupported_grant_type',
          'Only authorization_code and refresh_token are supported.',
        )
      } catch (error) {
        if (error instanceof McpOauthError) {
          return oauthError(reply, error.status, error.code, error.message)
        }
        throw error
      }
    },
  )

  // The Settings surface's list of approved clients, and the revoke action beside each one.
  // Spec 08: "a list of the clients already approved with a way to revoke one."
  app.get('/api/mcp/oauth/clients', async () => ({
    clients: listApprovedClients(database).map((client) => ({
      clientId: client.clientId,
      clientName: client.clientName,
      clientUri: client.clientUri,
      approvedAt: client.approvedAt,
    })),
  }))

  app.post<{ Body: { clientId?: string } }>(
    '/api/mcp/oauth/clients/revoke',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
      },
    },
    async (request) => {
      revokeClient(database, request.body.clientId as string, now())
      return { clients: listApprovedClients(database) }
    },
  )
}
