/**
 * `POST /api/mcp`, off unless `mcp.enabled` is true. Spec 12.
 *
 * JSON-RPC framing wins over the API's error envelope on this one route, which is spec 08
 * criterion 37's exception to its own criterion 1: this route is registered inside its own
 * Fastify encapsulation context, with its own `setErrorHandler`, so a malformed body never
 * reaches the shared handler that would answer it in the standard `{ error: ... }` shape (spec
 * 12, criterion 43).
 *
 * The credential checked here is a token Caroline's own authorisation server issued
 * (`src/mcp/oauth`), and nothing else. Slice 2's bearer token, `mcp.accessToken`, is gone
 * outright: there is no setting for one, and a value that would once have been accepted here is
 * refused (spec 12, criterion 32). This is a distinct credential from the API's own, which spec
 * 13 already replaced with a login, and this route touches neither that setting nor the session
 * cookie the browser carries (criterion 33).
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isLoopbackHost, stripHostnameBrackets } from '../auth/boundary.js'
import { loopbackHostnames } from '../auth/origin.js'
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import type { PlanRegeneration } from '../chat/types.js'
import { latestDailyPlan } from '../db/repositories/daily-plans.js'
import { PLAN_JOB } from '../jobs/plan.js'
import type { CarolineJobs } from '../jobs/registry.js'
import { formatLocalDate, localDateAt } from '../domain/time.js'
import type { ChangeFeed } from '../server/changes.js'
import { callMcpTool } from './call.js'
import { validateAccessToken } from './oauth/service.js'
import { protectedResourceMetadataUrl } from './oauth/resource.js'
import {
  isNotification as isJsonRpcNotification,
  jsonRpcError,
  jsonRpcErrorCodes,
  jsonRpcResult,
  MCP_FALLBACK_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  readEnvelope,
  readMeta,
  readRequestedProtocolVersion,
  type JsonRpcErrorBody,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from './protocol.js'
import { mcpToolDescriptors } from './tools.js'

/** Named once and reused by both `server/discover` and `initialize`, so the two cannot drift
 * into naming this server two different things. */
const MCP_SERVER_INFO = { name: 'caroline', version: '1.0.0' } as const

export interface McpRouteContext {
  readonly config: Config
  readonly database: Database
  readonly changes: ChangeFeed
  readonly now: () => number
  readonly jobs: CarolineJobs
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const [scheme, value] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && value !== undefined && value !== '' ? value : null
}

/**
 * The challenge names the protected resource metadata document, which is what a conformant
 * client follows to find the authorisation server (spec 12, criterion 8 and criterion 26).
 */
function unauthorized(reply: FastifyReply, config: Config): FastifyReply {
  return reply
    .header(
      'www-authenticate',
      `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}"`,
    )
    .status(401)
    .send({ error: 'unauthorized' })
}

/** The hostname a `Host` header names, with an IPv6 literal's brackets stripped and its port cut,
 * so it compares against `isLoopbackHost`'s unbracketed, portless set. */
function hostnameOf(value: string): string {
  return value.startsWith('[')
    ? stripHostnameBrackets(value.match(/^\[.+\]/)?.[0] ?? value)
    : (value.split(':')[0] ?? value)
}

/**
 * Compared against `loopbackHostnames`, not `loopbackHosts`: `URL#hostname` normalises an
 * IPv4-mapped IPv6 literal (`::ffff:127.0.0.1` parses to `[::ffff:7f00:1]`), so a legitimate
 * loopback `Origin` header in that form would otherwise fail to match the unnormalised set and
 * be refused with 403. `src/auth/origin.ts` had the same bug in `isAcceptableOrigin` and this is
 * the fix it already carries, reused rather than repeated.
 */
function isAcceptableMcpOrigin(origin: string): boolean {
  try {
    return loopbackHostnames.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * JSON-RPC 2.0 (https://www.jsonrpc.org/specification, section 4.1): "A Notification is a
 * Request object without an 'id' member... The Server MUST NOT reply to a Notification,
 * including those that are within a batch request." `readEnvelope` already preserves the
 * distinction between "no `id` at all" and "`id` explicitly `null`" by only setting the `id`
 * property when the body had one, so `envelope.id === undefined` is exactly "this was a
 * Notification."
 *
 * Every call site that would otherwise answer with a JSON-RPC body funnels through this instead
 * of calling `reply.send` directly, so the rule holds for every method Caroline dispatches
 * (`initialize`, `server/discover`, `tools/list`, `tools/call`, and the `methodNotFound`
 * fallback alike), not only the specific notification (`notifications/initialized`) that
 * motivated it. A request that does carry an `id`, however malformed otherwise, is answered
 * exactly as before: this only changes behaviour for the no-`id` case.
 *
 * `202 Accepted` with an empty body, rather than `204 No Content`, because the request was
 * accepted for processing rather than definitively completed with nothing further to say; both
 * are within JSON-RPC 2.0's discretion, since the specification only forbids a JSON-RPC
 * response body, not a particular HTTP status.
 */
function sendJsonRpc(
  reply: FastifyReply,
  isNotification: boolean,
  status: number,
  body: JsonRpcSuccess | JsonRpcErrorBody,
): FastifyReply {
  if (isNotification) return reply.status(202).send()
  return reply.status(status).send(body)
}

/**
 * Registers the endpoint, and only where it is turned on. Spec 12, criterion 5: with
 * `mcp.enabled` false, nothing here is registered at all, asserted over the registered route
 * list rather than by requesting one.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteContext): void {
  if (!deps.config.mcp.enabled) return

  const regeneratePlan = async (): Promise<PlanRegeneration> => {
    const outcome = await deps.jobs.scheduler.run(PLAN_JOB, 'manual')
    if (outcome.status === 'already-running') return { status: 'already-running' }
    if (outcome.status === 'unknown') {
      return { status: 'refused', detail: 'The planner is not registered in this process.' }
    }
    if (outcome.run.status !== 'success') {
      return { status: 'refused', detail: outcome.run.error ?? 'The plan could not be drawn.' }
    }

    const today = formatLocalDate(localDateAt(deps.now(), deps.config.jobs.timezone))
    return { status: 'drawn', summary: latestDailyPlan(deps.database, today)?.summary ?? null }
  }

  // Its own encapsulation, so `instance.setErrorHandler` below governs this route alone and
  // never the rest of the API. Spec 08, criterion 37.
  void app.register(async (instance) => {
    instance.setErrorHandler<FastifyError>((error, request, reply) => {
      // `parseError` is for a body this route could not read as JSON-RPC at all: invalid JSON, or
      // schema validation rejecting it before a handler ever ran. Anything else reaching this
      // handler is this route's own code failing on a request it did parse, which is
      // `internalError` rather than a claim that the request itself was malformed.
      const isParseFailure =
        error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error.code === 'FST_ERR_VALIDATION'

      // A parse failure means `request.body` never became a JSON-RPC envelope at all, so there is
      // no `id` to read and this can't be recognised as a Notification: it is answered exactly as
      // before. Anything else reaching this handler is this route's own code failing after
      // `readEnvelope` already succeeded on the body, so re-reading it here recovers the same
      // envelope the handler was working from, and `isJsonRpcNotification` (`./protocol.js`)
      // applies the same JSON-RPC 2.0 "MUST NOT reply to a Notification" rule this route's happy
      // path already follows everywhere else, via `sendJsonRpc` above.
      const envelope = isParseFailure ? null : readEnvelope(request.body)
      const notification = envelope !== null && isJsonRpcNotification(envelope)

      // The real id, when one was actually recovered: `id: null` is only correct for a genuine
      // parse failure, where the id truly can't be known. Once `readEnvelope` has recovered the
      // envelope, its id (or lack of one, for a Notification, which `sendJsonRpc` above never
      // answers anyway) is known and must be threaded through rather than discarded.
      const id = envelope === null ? null : (envelope.id ?? null)

      sendJsonRpc(
        reply,
        notification,
        200,
        isParseFailure
          ? jsonRpcError(id, jsonRpcErrorCodes.parseError, `Malformed request: ${error.message}`)
          : jsonRpcError(id, jsonRpcErrorCodes.internalError, error.message),
      )
    })

    instance.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const origin = request.headers.origin
      if (origin !== undefined && !isAcceptableMcpOrigin(origin)) {
        await reply.status(403).send({ error: 'origin not accepted' })
        return
      }

      const hostHeader = request.headers.host
      if (hostHeader === undefined || !isLoopbackHost(hostnameOf(hostHeader))) {
        await reply.status(403).send({ error: 'host not accepted' })
        return
      }

      const token = bearerToken(request)
      const validated =
        token === null ? null : validateAccessToken(deps.config, deps.database, token, deps.now())
      if (validated === null) {
        await unauthorized(reply, deps.config)
        return
      }
    })

    instance.post(
      '/api/mcp',
      // A permissive schema: this route validates its own body, in JSON-RPC's own shape, rather
      // than through Fastify's, which would answer a violation in the API's error envelope.
      { schema: { body: { type: 'object' } } },
      async (request, reply) => {
        const protocolVersionHeader = request.headers['mcp-protocol-version']
        const methodHeader = request.headers['mcp-method']
        const nameHeader = request.headers['mcp-name']

        const envelope = readEnvelope(request.body)
        if (envelope === null) {
          return reply
            .status(200)
            .send(jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, 'Not a JSON-RPC request.'))
        }

        const meta = readMeta(envelope.params)
        const id = envelope.id ?? null
        // JSON-RPC 2.0 section 4.1: a Notification is a request with no `id` member at all, and
        // the server MUST NOT reply to one. See `sendJsonRpc` above, and `isJsonRpcNotification`
        // for the shared check (also used by this route's `setErrorHandler`, so the rule can't
        // drift between the happy path and the error path).
        const isNotification = isJsonRpcNotification(envelope)

        if (
          protocolVersionHeader !== undefined &&
          meta.protocolVersion !== null &&
          protocolVersionHeader !== meta.protocolVersion
        ) {
          return sendJsonRpc(
            reply,
            isNotification,
            400,
            jsonRpcError(
              id,
              jsonRpcErrorCodes.headerMismatch,
              'MCP-Protocol-Version disagrees with the protocol version in the request body.',
            ),
          )
        }

        // Revision 2026-07-28 (SEP-2243) requires Mcp-Method on every request, and Mcp-Name on
        // tools/call, resources/read and prompts/get. Strict rejection here would refuse Claude
        // Code outright: its MCP client does not send either header yet (captured 2026-08-17
        // against Claude Code 2.1.233's actual `initialize` request, which carries neither), and
        // that gap is Anthropic's to close, not this client's fault for existing. So this only
        // rejects a header that disagrees with the body, never one that is simply absent: an
        // absent header is treated as "this client hasn't implemented this part of the revision
        // yet", not as a malformed request. A client that does send the header is still held to
        // exact agreement. See docs/specs/12-mcp-server.md, "Header interoperability" for the
        // full reasoning; revisit once client support for these headers is widespread.
        if (methodHeader !== undefined && methodHeader !== envelope.method) {
          return sendJsonRpc(
            reply,
            isNotification,
            400,
            jsonRpcError(
              id,
              jsonRpcErrorCodes.invalidRequest,
              'Mcp-Method is required and must agree with the request body.',
            ),
          )
        }

        if (envelope.method === 'tools/call') {
          const toolName =
            envelope.params !== null &&
            typeof envelope.params === 'object' &&
            typeof (envelope.params as { name?: unknown }).name === 'string'
              ? (envelope.params as { name: string }).name
              : null

          if (nameHeader !== undefined && nameHeader !== toolName) {
            return sendJsonRpc(
              reply,
              isNotification,
              400,
              jsonRpcError(
                id,
                jsonRpcErrorCodes.invalidRequest,
                'Mcp-Name is required on tools/call and must agree with the request body.',
              ),
            )
          }
        }

        return handleMethod(deps, { regeneratePlan }, envelope, isNotification, reply)
      },
    )
  })
}

interface HandlerDeps {
  readonly regeneratePlan: () => Promise<PlanRegeneration>
}

async function handleMethod(
  deps: McpRouteContext,
  handlerDeps: HandlerDeps,
  envelope: JsonRpcRequest,
  isNotification: boolean,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const id = envelope.id ?? null

  if (envelope.method === 'server/discover') {
    return sendJsonRpc(
      reply,
      isNotification,
      200,
      jsonRpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        server: MCP_SERVER_INFO,
      }),
    )
  }

  // Revision 2026-07-28 removed the handshake outright: no `initialize`, no
  // `notifications/initialized`, no session identifier (see docs/specs/12-mcp-server.md, "The
  // session, which the protocol no longer has"). Caroline's own derived-session logic does not
  // depend on one either. But the shipped Claude Code MCP client still opens every connection
  // with an `initialize` call regardless of what this revision says, and until this handler
  // existed that fell through to `methodNotFound`, which the client surfaces to the user as a
  // failed connection rather than a successful one. So this answers the handshake the same way
  // `server/discover` answers its own capability query: a pure, stateless echo of what this
  // server supports, computed fresh on every call. No `Mcp-Session-Id` is issued, nothing is
  // stored, and a client that never calls this method loses nothing, because Caroline never
  // required it. See "Handshake interoperability" in docs/specs/12-mcp-server.md.
  //
  // What this echoes is negotiated, not a naive echo of whatever the client asked for.
  // `readRequestedProtocolVersion` reads the legacy top-level `params.protocolVersion` field a
  // client built before revision 2026-07-28 actually sends (Claude Code among them), falling
  // back to `params._meta.protocolVersion` for a hypothetical caller native to the new
  // revision. A client that asked for exactly `MCP_PROTOCOL_VERSION` gets it back, because
  // Caroline genuinely runs it; any other request, including none at all, gets
  // `MCP_FALLBACK_PROTOCOL_VERSION`, a specific version Caroline has decided the current client
  // ecosystem actually accepts, rather than an arbitrary string parroted back that would assert
  // a compatibility never decided. See "Version interoperability" in docs/specs/12-mcp-server.md.
  if (envelope.method === 'initialize') {
    const requestedProtocolVersion = readRequestedProtocolVersion(envelope.params)
    const negotiatedProtocolVersion =
      requestedProtocolVersion === MCP_PROTOCOL_VERSION
        ? MCP_PROTOCOL_VERSION
        : MCP_FALLBACK_PROTOCOL_VERSION

    return sendJsonRpc(
      reply,
      isNotification,
      200,
      jsonRpcResult(id, {
        protocolVersion: negotiatedProtocolVersion,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      }),
    )
  }

  if (envelope.method === 'tools/list') {
    return sendJsonRpc(
      reply,
      isNotification,
      200,
      jsonRpcResult(id, { tools: mcpToolDescriptors() }),
    )
  }

  if (envelope.method === 'tools/call') {
    const params = envelope.params
    if (params === null || typeof params !== 'object') {
      return sendJsonRpc(
        reply,
        isNotification,
        200,
        jsonRpcError(id, jsonRpcErrorCodes.invalidParams, 'tools/call requires params.'),
      )
    }

    const { name, arguments: toolArguments } = params as {
      name?: unknown
      arguments?: unknown
    }

    if (typeof name !== 'string') {
      return sendJsonRpc(
        reply,
        isNotification,
        200,
        jsonRpcError(id, jsonRpcErrorCodes.invalidParams, 'tools/call requires a tool name.'),
      )
    }

    const meta = readMeta(params)

    const result = await callMcpTool(
      {
        database: deps.database,
        config: deps.config,
        now: deps.now,
        calendarConnected: deps.jobs.calendarConnected,
        regeneratePlan: handlerDeps.regeneratePlan,
        changes: deps.changes,
      },
      { clientName: meta.clientName, tool: name, arguments: toolArguments },
    )

    // A refusal from the registry, and a held operation, both reach the client as a tool result
    // marked as an error rather than as a protocol error: a tool that declined to do something
    // is a tool that answered. Spec 12, "Errors and limits".
    if (result.outcome === 'error') {
      return sendJsonRpc(
        reply,
        isNotification,
        200,
        jsonRpcResult(id, { content: [{ type: 'text', text: result.message }], isError: true }),
      )
    }

    if (result.outcome === 'held') {
      return sendJsonRpc(
        reply,
        isNotification,
        200,
        jsonRpcResult(id, { content: [{ type: 'text', text: result.message }], isError: true }),
      )
    }

    return sendJsonRpc(
      reply,
      isNotification,
      200,
      jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result.data) }],
        isError: false,
      }),
    )
  }

  return sendJsonRpc(
    reply,
    isNotification,
    200,
    jsonRpcError(id, jsonRpcErrorCodes.methodNotFound, `No such method: ${envelope.method}.`),
  )
}
