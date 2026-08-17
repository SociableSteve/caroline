/**
 * `POST /api/mcp`, off unless `mcp.enabled` is true. Spec 12, slice 2.
 *
 * JSON-RPC framing wins over the API's error envelope on this one route, which is spec 08
 * criterion 37's exception to its own criterion 1: this route is registered inside its own
 * Fastify encapsulation context, with its own `setErrorHandler`, so a malformed body never
 * reaches the shared handler that would answer it in the standard `{ error: ... }` shape (spec
 * 12, criterion 43).
 *
 * The credential checked here is `mcp.accessToken`, slice 2's bearer token: scaffolding, by the
 * spec's own account, kept only until slice 3's authorisation server replaces it. It is a
 * distinct setting from the API's own credential, which spec 13 already removed in favour of a
 * login, and this route touches neither that setting nor the session cookie the browser carries.
 */
import { timingSafeEqual } from 'node:crypto'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isLoopbackHost, stripHostnameBrackets } from '../auth/boundary.js'
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import type { PlanRegeneration } from '../chat/types.js'
import { latestDailyPlan } from '../db/repositories/daily-plans.js'
import { PLAN_JOB } from '../jobs/plan.js'
import type { CarolineJobs } from '../jobs/registry.js'
import { formatLocalDate, localDateAt } from '../domain/time.js'
import type { ChangeFeed } from '../server/changes.js'
import { callMcpTool } from './call.js'
import {
  jsonRpcError,
  jsonRpcErrorCodes,
  jsonRpcResult,
  MCP_PROTOCOL_VERSION,
  readEnvelope,
  readMeta,
  type JsonRpcRequest,
} from './protocol.js'
import { mcpToolDescriptors } from './tools.js'

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

/** Constant-time, as every credential comparison in this codebase is. Spec 09, criterion 6. */
function tokenMatches(presented: string, configured: string): boolean {
  const left = Buffer.from(presented)
  const right = Buffer.from(configured)
  return left.length === right.length && timingSafeEqual(left, right)
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.header('www-authenticate', 'Bearer').status(401).send({ error: 'unauthorized' })
}

/** The hostname a `Host` header names, with an IPv6 literal's brackets stripped and its port cut,
 * so it compares against `isLoopbackHost`'s unbracketed, portless set. */
function hostnameOf(value: string): string {
  return value.startsWith('[')
    ? stripHostnameBrackets(value.match(/^\[.+\]/)?.[0] ?? value)
    : (value.split(':')[0] ?? value)
}

function isAcceptableMcpOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(stripHostnameBrackets(new URL(origin).hostname))
  } catch {
    return false
  }
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
    instance.setErrorHandler<FastifyError>((error, _request, reply) => {
      reply
        .status(200)
        .send(
          jsonRpcError(null, jsonRpcErrorCodes.parseError, `Malformed request: ${error.message}`),
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
      const configured = deps.config.mcp.accessToken
      if (configured === null || token === null || !tokenMatches(token, configured)) {
        await unauthorized(reply)
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

        if (
          protocolVersionHeader !== undefined &&
          meta.protocolVersion !== null &&
          protocolVersionHeader !== meta.protocolVersion
        ) {
          return reply
            .status(400)
            .send(
              jsonRpcError(
                id,
                jsonRpcErrorCodes.headerMismatch,
                'MCP-Protocol-Version disagrees with the protocol version in the request body.',
              ),
            )
        }

        if (methodHeader === undefined || methodHeader !== envelope.method) {
          return reply
            .status(400)
            .send(
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

          if (nameHeader === undefined || toolName === null || nameHeader !== toolName) {
            return reply
              .status(400)
              .send(
                jsonRpcError(
                  id,
                  jsonRpcErrorCodes.invalidRequest,
                  'Mcp-Name is required on tools/call and must agree with the request body.',
                ),
              )
          }
        }

        return handleMethod(deps, { regeneratePlan }, envelope, reply)
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
  reply: FastifyReply,
): Promise<FastifyReply> {
  const id = envelope.id ?? null

  if (envelope.method === 'server/discover') {
    return reply.send(
      jsonRpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        server: { name: 'caroline', version: '1.0.0' },
      }),
    )
  }

  if (envelope.method === 'tools/list') {
    return reply.send(jsonRpcResult(id, { tools: mcpToolDescriptors() }))
  }

  if (envelope.method === 'tools/call') {
    const params = envelope.params
    if (params === null || typeof params !== 'object') {
      return reply
        .status(200)
        .send(jsonRpcError(id, jsonRpcErrorCodes.invalidParams, 'tools/call requires params.'))
    }

    const { name, arguments: toolArguments } = params as {
      name?: unknown
      arguments?: unknown
    }

    if (typeof name !== 'string') {
      return reply
        .status(200)
        .send(jsonRpcError(id, jsonRpcErrorCodes.invalidParams, 'tools/call requires a tool name.'))
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
      return reply.send(
        jsonRpcResult(id, { content: [{ type: 'text', text: result.message }], isError: true }),
      )
    }

    if (result.outcome === 'held') {
      return reply.send(
        jsonRpcResult(id, { content: [{ type: 'text', text: result.message }], isError: true }),
      )
    }

    return reply.send(
      jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result.data) }],
        isError: false,
      }),
    )
  }

  return reply
    .status(200)
    .send(jsonRpcError(id, jsonRpcErrorCodes.methodNotFound, `No such method: ${envelope.method}.`))
}
