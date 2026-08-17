/**
 * MCP sessions and the audit trail over them. Spec 12: the protocol carries no session
 * identifier, so a session is found by the client's declared name and continued while calls
 * keep arriving inside the idle window. It is also where a session's open turn lives, because
 * that turn spans many separate JSON-RPC calls rather than the one request a browser turn does:
 * `src/chat/gate.ts` reads and writes it through `sessionAccumulator` and
 * `saveSessionAccumulator` below, and knows nothing about how it is stored.
 */
import { randomUUID } from 'node:crypto'
import type { Database } from '../connection.js'
import type { Row } from '../rows.js'
import { operationsOf } from '../../chat/confirm.js'
import type { GateAccumulator } from '../../chat/gate.js'
import { createConversation, getConfirmation } from './chat.js'

/** The sentinel a request declaring no client name is found and grouped by. Spec 12: "A request
 * declaring no client name is attributed to an unnamed client rather than refused." Not a value
 * a real client name can collide with, because it is never read back as one: `clientName` on the
 * session is null exactly when this was the key, and a client naming this string literally would
 * still be keyed by it under a different key, since the key is derived and never taken from input
 * verbatim without the prefix. */
const UNNAMED_CLIENT_KEY = '\0unnamed'

function clientKeyOf(clientName: string | null): string {
  return clientName === null ? UNNAMED_CLIENT_KEY : `name:${clientName}`
}

export interface McpSession {
  readonly id: string
  readonly conversationId: string
  readonly clientName: string | null
  readonly lastSeenAt: number
}

interface SessionRow {
  readonly id: string
  readonly conversationId: string
  readonly clientName: string | null
  readonly lastSeenAt: number
  readonly currentTurnMessageId: string | null
  readonly mutatedTaskIds: readonly string[]
  readonly bulkConfirmationId: string | null
  readonly bulkDescriptions: readonly string[]
  readonly accumulatorVersion: number
}

const sessionColumns = `id, conversation_id, client_name, last_seen_at, current_turn_message_id,
  mutated_task_ids, bulk_confirmation_id, bulk_descriptions, accumulator_version`

function toSessionRow(row: Row): SessionRow {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    clientName: row.client_name === null ? null : String(row.client_name),
    lastSeenAt: Number(row.last_seen_at),
    currentTurnMessageId:
      row.current_turn_message_id === null ? null : String(row.current_turn_message_id),
    mutatedTaskIds: parseStringArray(row.mutated_task_ids),
    bulkConfirmationId: row.bulk_confirmation_id === null ? null : String(row.bulk_confirmation_id),
    bulkDescriptions: parseStringArray(row.bulk_descriptions),
    accumulatorVersion: Number(row.accumulator_version),
  }
}

function parseStringArray(value: unknown): readonly string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

function toMcpSession(row: SessionRow): McpSession {
  return {
    id: row.id,
    conversationId: row.conversationId,
    clientName: row.clientName,
    lastSeenAt: row.lastSeenAt,
  }
}

function getSessionRow(database: Database, id: string): SessionRow | null {
  const row = database.prepare(`select ${sessionColumns} from mcp_sessions where id = ?`).get(id)
  return row === undefined ? null : toSessionRow(row as Row)
}

export interface FindOrCreateSessionOptions {
  /** The client's declared name, from `clientInfo`, or null where it declared none. */
  readonly clientName: string | null
  readonly sessionIdleMinutes: number
}

/**
 * The session a call belongs to: the most recently seen one for this client, if it was seen
 * within the idle window, or a new one with a new conversation otherwise. Touches `last_seen_at`
 * either way, which is what keeps a session alive for a client still calling.
 */
export function findOrCreateSession(
  database: Database,
  { clientName, sessionIdleMinutes }: FindOrCreateSessionOptions,
  now: number,
): McpSession {
  const clientKey = clientKeyOf(clientName)
  const idleMs = sessionIdleMinutes * 60_000

  const existing = database
    .prepare(
      `select ${sessionColumns} from mcp_sessions
       where client_key = ?
       order by last_seen_at desc
       limit 1`,
    )
    .get(clientKey)

  if (existing !== undefined) {
    const row = toSessionRow(existing as Row)
    if (now - row.lastSeenAt <= idleMs) {
      database.prepare('update mcp_sessions set last_seen_at = ? where id = ?').run(now, row.id)
      return toMcpSession({ ...row, lastSeenAt: now })
    }
  }

  const conversation = createConversation(
    database,
    {
      title: clientName === null ? 'MCP: unnamed client' : `MCP: ${clientName}`,
      source: 'mcp',
      clientName,
    },
    now,
  )

  const id = randomUUID()
  database
    .prepare(
      `insert into mcp_sessions
         (id, conversation_id, client_key, client_name, last_seen_at, created_at)
       values (:id, :conversation_id, :client_key, :client_name, :last_seen_at, :created_at)`,
    )
    .run({
      id,
      conversation_id: conversation.id,
      client_key: clientKey,
      client_name: clientName,
      last_seen_at: now,
      created_at: now,
    })

  return { id, conversationId: conversation.id, clientName, lastSeenAt: now }
}

/** Clears the accumulated state once its confirmation has been decided, so the caller sees an
 * empty accumulator and opens a fresh turn on its next write. Read-only otherwise.
 *
 * Guarded by `accumulator_version` the same way `saveSessionAccumulator` is below: a second call
 * racing this one to clear the same decided confirmation would otherwise clear it twice, and the
 * second clear's `where` clause finding no row to match is exactly how it is told its read is
 * stale rather than silently repeating a write that already happened. */
function openTurnState(database: Database, row: SessionRow): SessionRow {
  if (row.bulkConfirmationId === null) return row

  const confirmation = getConfirmation(database, row.bulkConfirmationId)
  if (confirmation !== null && confirmation.decidedAt === null) return row

  const changed = database
    .prepare(
      `update mcp_sessions
       set current_turn_message_id = null, mutated_task_ids = '[]',
           bulk_confirmation_id = null, bulk_descriptions = '[]',
           accumulator_version = accumulator_version + 1
       where id = ? and accumulator_version = ?`,
    )
    .run(row.id, row.accumulatorVersion).changes

  // Lost the race to clear it: another call already did, so the row is read back fresh rather
  // than assumed to be the stale shape this function was about to return.
  if (changed === 0) {
    const fresh = getSessionRow(database, row.id)
    if (fresh === null) throw new Error(`no such MCP session: ${row.id}`)
    return fresh
  }

  return {
    ...row,
    currentTurnMessageId: null,
    mutatedTaskIds: [],
    bulkConfirmationId: null,
    bulkDescriptions: [],
    accumulatorVersion: row.accumulatorVersion + 1,
  }
}

export interface OpenSessionTurn {
  /** Null where nothing has opened a turn yet: the caller creates one before its first write. */
  readonly turnMessageId: string | null
  /** The `GateAccumulator` shape `src/chat/gate.ts` reads and mutates. */
  readonly accumulator: GateAccumulator
  /**
   * The version this read saw, to be handed back to `saveSessionAccumulator` unchanged. An MCP
   * session's turn spans separate JSON-RPC requests, so the work between this read and that write
   * (running the tool itself) is a gap another call to the same session can land in; the version
   * is what lets the write notice and refuse to clobber it instead of silently losing it.
   */
  readonly accumulatorVersion: number
}

/**
 * The session's open turn, in one read: the message a write should attach to (creating one is
 * the caller's job, since that is a `chat_messages` insert this module does not own), and the
 * accumulator `src/chat/gate.ts` gates the write against. One row read and, where the open
 * confirmation has been decided since, one update, rather than the two of each a caller asking
 * for the message id and the accumulator separately would otherwise repeat. Rebuilt from the
 * database on every call, because an MCP session's calls are separate requests rather than one
 * function's stack.
 */
export function openSessionTurn(database: Database, sessionId: string): OpenSessionTurn {
  const row = getSessionRow(database, sessionId)
  if (row === null) throw new Error(`no such MCP session: ${sessionId}`)

  const opened = openTurnState(database, row)
  const confirmation =
    opened.bulkConfirmationId === null ? null : getConfirmation(database, opened.bulkConfirmationId)

  return {
    turnMessageId: opened.currentTurnMessageId,
    accumulator: {
      mutatedTaskIds: new Set(opened.mutatedTaskIds),
      bulkConfirmation:
        confirmation === null
          ? null
          : {
              record: confirmation,
              operations: operationsOf(confirmation),
              descriptions: [...opened.bulkDescriptions],
            },
    },
    accumulatorVersion: opened.accumulatorVersion,
  }
}

/**
 * Writes an accumulator back after a write tool has run, and returns the message id its record
 * should be attached to: the open turn, or a freshly created one where there was none.
 *
 * `expectedVersion` is what `openSessionTurn` saw when it read the row this accumulator was built
 * from. The tool itself ran between that read and this write, which is a gap another call against
 * the same session can land in; the `where` clause below only takes effect if nothing else wrote
 * to the row in between, so a lost race is answered with an error rather than a silently
 * overwritten update from whichever call landed in the gap.
 */
export function saveSessionAccumulator(
  database: Database,
  sessionId: string,
  turnMessageId: string,
  accumulator: GateAccumulator,
  expectedVersion: number,
): void {
  const changed = database
    .prepare(
      `update mcp_sessions
       set current_turn_message_id = ?, mutated_task_ids = ?,
           bulk_confirmation_id = ?, bulk_descriptions = ?,
           accumulator_version = accumulator_version + 1
       where id = ? and accumulator_version = ?`,
    )
    .run(
      turnMessageId,
      JSON.stringify([...accumulator.mutatedTaskIds]),
      accumulator.bulkConfirmation?.record.id ?? null,
      JSON.stringify(accumulator.bulkConfirmation?.descriptions ?? []),
      sessionId,
      expectedVersion,
    ).changes

  if (changed === 0) {
    throw new Error(
      `MCP session ${sessionId}'s turn state changed under a concurrent call; not overwriting it`,
    )
  }
}

export interface RecordCallInput {
  readonly sessionId: string
  readonly tool: string
  readonly argumentsDigest: string
  readonly held: boolean
  readonly contentLevel: string
  readonly policyVersion: string
  readonly itemCount: number
}

/** One audit row per tool call. Spec 12, criterion 24: no answered item text in it. */
export function recordMcpCall(database: Database, input: RecordCallInput, now: number): void {
  database
    .prepare(
      `insert into mcp_calls
         (id, session_id, tool, arguments_digest, held, content_level, policy_version,
          item_count, created_at)
       values (:id, :session_id, :tool, :arguments_digest, :held, :content_level,
          :policy_version, :item_count, :created_at)`,
    )
    .run({
      id: randomUUID(),
      session_id: input.sessionId,
      tool: input.tool,
      arguments_digest: input.argumentsDigest,
      held: input.held ? 1 : 0,
      content_level: input.contentLevel,
      policy_version: input.policyVersion,
      item_count: input.itemCount,
      created_at: now,
    })
}

export interface McpCallRecord {
  readonly id: string
  readonly sessionId: string
  readonly tool: string
  readonly argumentsDigest: string
  readonly held: boolean
  readonly contentLevel: string
  readonly policyVersion: string
  readonly itemCount: number
  readonly createdAt: number
}

/** For tests and, eventually, an audit surface: every call recorded against a session. */
export function listMcpCalls(database: Database, sessionId: string): McpCallRecord[] {
  return database
    .prepare(
      `select id, session_id, tool, arguments_digest, held, content_level, policy_version,
              item_count, created_at
       from mcp_calls where session_id = ? order by created_at, id`,
    )
    .all(sessionId)
    .map((raw) => {
      const row = raw as Row
      return {
        id: String(row.id),
        sessionId: String(row.session_id),
        tool: String(row.tool),
        argumentsDigest: String(row.arguments_digest),
        held: Number(row.held) !== 0,
        contentLevel: String(row.content_level),
        policyVersion: String(row.policy_version),
        itemCount: Number(row.item_count),
        createdAt: Number(row.created_at),
      }
    })
}
