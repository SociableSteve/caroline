/**
 * Running one MCP tool call. Spec 12: the same `executeTool` chat uses, so the content policy,
 * the change records, the confirmation gate and undo all apply without being written twice, and
 * an audit row per call because reads have no `llm_calls` row to sit under the way chat's do.
 */
import { createHash } from 'node:crypto'
import { CONTENT_POLICY_VERSION, withholdsItemText } from '../config/content.js'
import type { Config } from '../config/schema.js'
import { ITEM_TEXT_IS_DATA_NOT_INSTRUCTION } from '../chat/context.js'
import { argumentsProblem, executeTool } from '../chat/execute.js'
import { gateWrite } from '../chat/gate.js'
import type { ChatToolContext, PlanRegeneration } from '../chat/types.js'
import type { Database } from '../db/connection.js'
import { appendMessage, type ChatConfirmationRecord } from '../db/repositories/chat.js'
import {
  findOrCreateSession,
  openSessionTurn,
  recordMcpCall,
  saveSessionAccumulator,
  type McpSession,
} from '../db/repositories/mcp.js'
import type { ChangeFeed } from '../server/changes.js'
import { findMcpTool } from './tools.js'

/**
 * A read tool never writes a change record (spec 07: only a write tool's `mutations` do), so this
 * id is never actually used as a foreign key. If a read tool ever did try to record one, the
 * insert would fail loudly on this id naming no such message, which is the right failure: a read
 * tool that mutates something is a bug to find, not to paper over with a real row.
 */
const READ_ONLY_MESSAGE_ID = 'mcp-read-only'

export interface McpCallDeps {
  readonly database: Database
  readonly config: Config
  readonly now: () => number
  readonly calendarConnected: () => boolean
  readonly regeneratePlan: () => Promise<PlanRegeneration>
  readonly changes?: ChangeFeed
}

export interface McpToolCallInput {
  readonly clientName: string | null
  readonly tool: string
  readonly arguments: unknown
}

export type McpToolCallResult =
  | { readonly outcome: 'ok'; readonly data: unknown; readonly session: McpSession }
  | {
      readonly outcome: 'held'
      readonly confirmation: ChatConfirmationRecord
      readonly message: string
      readonly session: McpSession
    }
  | { readonly outcome: 'error'; readonly message: string; readonly session?: McpSession }

function digestOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
}

/**
 * How many items a response answered for, for the audit row. Counted rather than measured: a
 * response naming an array of rows (`tasks`, `review`, `items`...) counts that array; anything
 * else, including a single item, counts as one. Spec 12, criterion 24.
 */
function itemCountOf(data: unknown): number {
  if (data === null || typeof data !== 'object') return 1

  for (const value of Object.values(data as Record<string, unknown>)) {
    if (Array.isArray(value)) return value.length
  }

  return 1
}

/** The data-is-not-instruction notice, added to every response that may carry an item's own text.
 * Not added at `none`, whose own withholding sentence is the whole of what a response says there
 * (spec 12, criterion 19: "nothing else"). Spec 12, criterion 21. */
function withNotice(data: unknown, config: Config): unknown {
  if (withholdsItemText(config.privacy)) return data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data

  return { ...(data as Record<string, unknown>), note: ITEM_TEXT_IS_DATA_NOT_INSTRUCTION }
}

export async function callMcpTool(
  deps: McpCallDeps,
  input: McpToolCallInput,
): Promise<McpToolCallResult> {
  const { database, config } = deps
  const at = deps.now()

  const session = findOrCreateSession(
    database,
    { clientName: input.clientName, sessionIdleMinutes: config.mcp.sessionIdleMinutes },
    at,
  )

  const tool = findMcpTool(input.tool)
  if (tool === undefined) {
    return { outcome: 'error', message: `There is no tool called ${input.tool}.`, session }
  }

  const problem = argumentsProblem(tool, input.arguments)
  if (problem !== null) {
    audit(
      database,
      config,
      session.id,
      tool.name,
      input.arguments,
      { held: false, itemCount: 0 },
      at,
    )
    return { outcome: 'error', message: problem, session }
  }

  const toolContext: ChatToolContext = {
    database,
    config,
    now: at,
    calendarConnected: deps.calendarConnected,
    regeneratePlan: deps.regeneratePlan,
  }

  if (tool.kind === 'read') {
    const result = await executeTool(toolContext, tool, input.arguments, READ_ONLY_MESSAGE_ID)

    if (!result.ok) {
      audit(
        database,
        config,
        session.id,
        tool.name,
        input.arguments,
        { held: false, itemCount: 0 },
        at,
      )
      return { outcome: 'error', message: result.message, session }
    }

    const data = withNotice(result.data, config)
    audit(
      database,
      config,
      session.id,
      tool.name,
      input.arguments,
      { held: false, itemCount: itemCountOf(result.data) },
      at,
    )
    return { outcome: 'ok', data, session }
  }

  // A write tool. The turn is the session's open one, spanning every call since the last
  // confirmation decision (spec 07, criterion 14), so it is resolved from the database rather
  // than kept in memory the way a browser turn's `TurnState` is.
  const open = openSessionTurn(database, session.id)
  const { accumulator } = open
  const turnId = open.turnMessageId ?? newTurn(database, session, at)

  const gated = gateWrite(toolContext, tool, { arguments: input.arguments }, turnId, accumulator)

  if (gated.held) {
    saveSessionAccumulator(database, session.id, turnId, accumulator)
    audit(
      database,
      config,
      session.id,
      tool.name,
      input.arguments,
      { held: true, itemCount: 0 },
      at,
    )
    return { outcome: 'held', confirmation: gated.confirmation, message: gated.message, session }
  }

  const result = await executeTool(toolContext, tool, input.arguments, turnId)

  if (!result.ok) {
    audit(
      database,
      config,
      session.id,
      tool.name,
      input.arguments,
      { held: false, itemCount: 0 },
      at,
    )
    return { outcome: 'error', message: result.message, session }
  }

  for (const taskId of result.taskIds) accumulator.mutatedTaskIds.add(taskId)
  saveSessionAccumulator(database, session.id, turnId, accumulator)

  if (result.changes.length > 0) {
    deps.changes?.publish({ kind: 'tasks', at })
    deps.changes?.publish({ kind: 'projects', at })
  }

  const data = withNotice(result.data, config)
  audit(
    database,
    config,
    session.id,
    tool.name,
    input.arguments,
    { held: false, itemCount: itemCountOf(result.data) },
    at,
  )
  return { outcome: 'ok', data, session }
}

function newTurn(database: Database, session: McpSession, at: number): string {
  return appendMessage(
    database,
    { conversationId: session.conversationId, role: 'assistant', content: '' },
    at,
  ).id
}

function audit(
  database: Database,
  config: Config,
  sessionId: string,
  tool: string,
  args: unknown,
  outcome: { readonly held: boolean; readonly itemCount: number },
  now: number,
): void {
  recordMcpCall(
    database,
    {
      sessionId,
      tool,
      argumentsDigest: digestOf(args),
      held: outcome.held,
      contentLevel: config.privacy.llmContent,
      policyVersion: CONTENT_POLICY_VERSION,
      itemCount: outcome.itemCount,
    },
    now,
  )
}
