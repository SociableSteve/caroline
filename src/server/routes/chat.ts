/**
 * Chat over HTTP. Spec 08's route table: a streamed turn, the conversation history, and the two
 * things a finished turn can be asked for.
 *
 * The turn streams as server-sent events over a POST, so the browser reads it with `fetch` rather
 * than with `EventSource`, which cannot post a body. As in the change feed, Fastify is handed the
 * socket with `hijack`: there is no payload for it to serialise and no moment at which it would.
 *
 * The turn runs to completion whether or not the browser is still there. Spec 08 criterion 7 asks
 * that a dropped connection leave the conversation recoverable, and the way to mean that is to
 * finish the work and write it down rather than to cancel it half-applied.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Config } from '../../config/schema.js'
import type { Database } from '../../db/index.js'
import { latestDailyPlan } from '../../db/repositories/daily-plans.js'
import {
  getConversation,
  getTranscript,
  listConversations,
  type ChatChangeRecord,
  type ChatConfirmationRecord,
  type ChatMessageRecord,
  type Conversation,
} from '../../db/repositories/chat.js'
import { createChatService, type ChatEvent, type PlanRegeneration } from '../../chat/index.js'
import { formatLocalDate, localDateAt } from '../../domain/time.js'
import { PLAN_JOB } from '../../jobs/plan.js'
import type { CarolineJobs } from '../../jobs/registry.js'
import { settingsFor } from '../../llm/index.js'
import type { ChangeFeed } from '../changes.js'
import { apiError } from '../errors.js'
import {
  chatConfirmBodySchema,
  chatConfirmResponseSchema,
  chatStatusResponseSchema,
  chatTurnBodySchema,
  chatUndoBodySchema,
  chatUndoResponseSchema,
  conversationListQuerySchema,
  conversationListResponseSchema,
  idParamsSchema,
  transcriptResponseSchema,
} from '../schemas.js'

export interface ChatRouteContext {
  readonly config: Config
  readonly database: Database
  readonly changes: ChangeFeed
  readonly now: () => number
  readonly jobs: CarolineJobs
}

/** Only the fields the schemas publish. Named, so a field added to a record is not published. */
function toChange(change: ChatChangeRecord) {
  return {
    id: change.id,
    position: change.position,
    tool: change.tool,
    summary: change.summary,
    entity: change.entity,
    entityId: change.entityId,
    createdAt: change.createdAt,
    undoneAt: change.undoneAt,
    undoable: change.undoable,
  }
}

function toConfirmation(confirmation: ChatConfirmationRecord) {
  return {
    id: confirmation.id,
    reason: confirmation.reason,
    tool: confirmation.tool,
    affectedCount: confirmation.affectedCount,
    summary: confirmation.summary,
    createdAt: confirmation.createdAt,
    decidedAt: confirmation.decidedAt,
    decision: confirmation.decision,
  }
}

function toMessage(message: ChatMessageRecord) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    toolCalls: message.toolCalls,
    toolCallLimitReached: message.toolCallLimitReached,
    readOnly: message.readOnly,
    inputTokens: message.inputTokens,
    outputTokens: message.outputTokens,
    stopReason: message.stopReason,
    error: message.error,
    changes: message.changes.map(toChange),
    confirmations: message.confirmations.map(toConfirmation),
  }
}

function toConversation(conversation: Conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messageCount,
    inputTokens: conversation.inputTokens,
    outputTokens: conversation.outputTokens,
  }
}

/**
 * An event as it goes down the wire. The same records the history routes return, so a client can
 * render a live turn and a reopened one with one piece of code.
 */
function toWireEvent(event: ChatEvent): { name: string; data: unknown } {
  switch (event.type) {
    case 'conversation':
      return { name: 'conversation', data: toConversation(event.conversation) }
    case 'user-message':
      return { name: 'user-message', data: toMessage(event.message) }
    case 'turn':
      return { name: 'turn', data: { messageId: event.messageId, readOnly: event.readOnly } }
    case 'text':
      return { name: 'text', data: { text: event.text } }
    case 'tool':
      return { name: 'tool', data: { name: event.name, outcome: event.outcome } }
    case 'change':
      return { name: 'change', data: toChange(event.change) }
    case 'confirmation':
      return { name: 'confirmation', data: toConfirmation(event.confirmation) }
    case 'done':
      return {
        name: 'done',
        data: {
          message: toMessage(event.message),
          conversation: toConversation(event.conversation),
        },
      }
    case 'error':
      return { name: 'error', data: { message: event.message } }
  }
}

export function registerChatRoutes(
  app: FastifyInstance,
  { config, database, changes, now, jobs }: ChatRouteContext,
): void {
  /**
   * Redrawing the plan from a chat tool takes the same path the regenerate route takes: through the
   * scheduler, so it is recorded in the run history and guarded against overlap like any other run.
   * Spec 06 keeps manual runs first-class rather than special.
   */
  const regeneratePlan = async (): Promise<PlanRegeneration> => {
    const outcome = await jobs.scheduler.run(PLAN_JOB, 'manual')

    if (outcome.status === 'already-running') return { status: 'already-running' }
    if (outcome.status === 'unknown') {
      return { status: 'refused', detail: 'The planner is not registered in this process.' }
    }
    if (outcome.run.status !== 'success') {
      return {
        status: 'refused',
        detail: outcome.run.error ?? 'The plan could not be drawn.',
      }
    }

    const today = formatLocalDate(localDateAt(now(), config.jobs.timezone))
    return { status: 'drawn', summary: latestDailyPlan(database, today)?.summary ?? null }
  }

  const chat = createChatService({
    database,
    config,
    llm: jobs.llm,
    now,
    calendarConnected: jobs.calendarConnected,
    regeneratePlan,
    changes,
  })

  app.get(
    '/api/chat/status',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {} },
        response: { 200: chatStatusResponseSchema },
      },
    },
    async () => {
      const settings = settingsFor(config, 'chat')

      return {
        configured: chat.isConfigured(),
        // Read-only covers both cases the UI has to say something about: nothing configured, and a
        // model that cannot use tools. Spec 07, criterion 7.
        readOnly: !chat.canWrite(),
        maxToolCalls: config.chat.maxToolCalls,
        bulkConfirmThreshold: config.chat.bulkConfirmThreshold,
        provider: settings.provider === 'none' ? null : settings.provider,
        model: settings.model,
      }
    },
  )

  app.get<{ Querystring: { limit: number } }>(
    '/api/chat/conversations',
    {
      schema: {
        querystring: conversationListQuerySchema,
        response: { 200: conversationListResponseSchema },
      },
    },
    async (request) => ({
      conversations: listConversations(database, request.query.limit).map(toConversation),
    }),
  )

  app.get<{ Params: { id: string } }>(
    '/api/chat/conversations/:id',
    {
      schema: { params: idParamsSchema, response: { 200: transcriptResponseSchema } },
    },
    async (request, reply) => {
      const transcript = getTranscript(database, request.params.id)
      if (transcript === null) return notFound(reply, 'conversation')

      return {
        conversation: toConversation(transcript.conversation),
        messages: transcript.messages.map(toMessage),
      }
    },
  )

  /**
   * The streamed turn. The body is validated by the schema before the socket is hijacked, so a bad
   * request still gets the standard error shape rather than an event stream saying so.
   */
  app.post<{ Body: { conversationId?: string; message: string } }>(
    '/api/chat',
    { schema: { body: chatTurnBodySchema } },
    async (request, reply) => {
      const { conversationId, message } = request.body

      // Checked before the socket is hijacked, so a bad id is a 404 in the standard error shape like
      // every other route rather than a 200 carrying an error event. The turn refuses it again on
      // its own account, which covers a conversation deleted between here and there.
      if (conversationId !== undefined && getConversation(database, conversationId) === null) {
        return notFound(reply, 'conversation')
      }

      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx and friends buffer a response body by default, which for a stream means holding
        // every event until the connection closes.
        'x-accel-buffering': 'no',
      })

      /**
       * Whether anybody is still listening. Only the response is watched: `request.raw` emits
       * `close` as soon as the posted body has been read, which is before the turn has even
       * started, so listening to that would treat every turn as abandoned.
       */
      let open = true
      reply.raw.on('close', () => {
        open = false
      })

      const emit = (event: ChatEvent) => {
        if (!open) return
        const { name, data } = toWireEvent(event)

        try {
          reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
        } catch {
          // The browser has gone. The turn carries on regardless: it is being recorded, and a
          // half-applied turn would be worse than one nobody watched.
          open = false
        }
      }

      try {
        const refusal = await chat.turn(
          { ...(conversationId === undefined ? {} : { conversationId }), message },
          emit,
        )

        if (refusal === 'no-such-conversation') {
          emit({ type: 'error', message: 'There is no conversation with that id.' })
        }
      } catch (error) {
        // Anything that escapes the turn loop is a bug rather than a provider failure, which the
        // loop reports itself. It is logged and said once, because the stream has already started
        // and there is no status code left to send.
        request.log.error({ err: error }, 'chat turn failed')
        emit({ type: 'error', message: 'The turn could not be completed.' })
      }

      if (open) reply.raw.end()
    },
  )

  app.post<{ Params: { id: string }; Body: { confirmed: boolean } }>(
    '/api/chat/confirmations/:id',
    {
      schema: {
        params: idParamsSchema,
        body: chatConfirmBodySchema,
        response: { 200: chatConfirmResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await chat.confirm(request.params.id, request.body.confirmed)

      if (!result.resolved) {
        if (result.reason === 'no-such-confirmation') return notFound(reply, 'confirmation')

        return reply
          .status(409)
          .send(
            apiError(
              'conflict',
              'That has already been decided. Reload the conversation to see what happened.',
            ),
          )
      }

      return {
        confirmation: toConfirmation(result.confirmation),
        changes: result.changes.map(toChange),
        failures: [...result.failures],
      }
    },
  )

  /**
   * Undoing the last turn of a conversation that changed anything. The turn is named in the body
   * rather than assumed, so a stale screen cannot undo a turn the user is not looking at: a
   * mismatch is refused rather than applied to whatever is latest.
   */
  app.post<{ Params: { id: string }; Body: { messageId: string } }>(
    '/api/chat/conversations/:id/undo',
    {
      schema: {
        params: idParamsSchema,
        body: chatUndoBodySchema,
        response: { 200: chatUndoResponseSchema },
      },
    },
    async (request, reply) => {
      if (getTranscript(database, request.params.id) === null) {
        return notFound(reply, 'conversation')
      }

      const result = chat.undo(request.params.id, request.body.messageId)

      if (!result.undone) {
        if (result.reason === 'nothing-to-undo') {
          return reply
            .status(409)
            .send(apiError('conflict', 'There is nothing left to undo in this conversation.'))
        }
        return reply
          .status(409)
          .send(
            apiError(
              'conflict',
              'Only the last change can be undone, and something has changed since. Reload the conversation.',
            ),
          )
      }

      return { changes: result.changes.map(toChange) }
    },
  )
}

function notFound(reply: FastifyReply, what: string): FastifyReply {
  return reply.status(404).send(apiError('not_found', `No such ${what}`))
}
