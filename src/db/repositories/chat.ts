/**
 * The conversation store. Spec 07: conversations persist across restarts and are listed so an
 * earlier one can be reopened, each turn carries a record of what it changed, and an operation
 * the user has to confirm is written down rather than held in the memory of the request that
 * proposed it.
 *
 * Nothing here decides policy. What counts as needing confirmation and what the inverse of a
 * change is are decided in `src/chat`; this writes and reads what it is given.
 */
import { randomUUID } from 'node:crypto'
import { withTransaction, type Database } from '../connection.js'
import { booleanToInteger, type Row } from '../rows.js'
import type {
  ChatChangeEntity,
  ChatConfirmationDecision,
  ChatConfirmationReason,
  ChatInverse,
  ChatRole,
} from '../../domain/chat.js'

/** The title is what the list is read by, so a first message longer than this is cut. */
export const CONVERSATION_TITLE_MAX = 80

export interface Conversation {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly messageCount: number
  /** Spec 07: token usage per conversation is recorded and shown. */
  readonly inputTokens: number
  readonly outputTokens: number
}

/** A recorded change, as the transcript shows it. The inverse is deliberately not on it. */
export interface ChatChangeRecord {
  readonly id: string
  readonly messageId: string
  readonly position: number
  readonly tool: string
  readonly summary: string
  readonly entity: ChatChangeEntity
  readonly entityId: string | null
  readonly createdAt: number
  readonly undoneAt: number | null
  /** False for a change with no inverse, so the UI offers undo only where it would work. */
  readonly undoable: boolean
}

export interface ChatConfirmationRecord {
  readonly id: string
  readonly messageId: string
  readonly reason: ChatConfirmationReason
  readonly tool: string
  /** The arguments the tool already validated, so confirming runs what was proposed. */
  readonly arguments: unknown
  readonly affectedCount: number
  readonly summary: string
  readonly createdAt: number
  readonly decidedAt: number | null
  readonly decision: ChatConfirmationDecision | null
}

export interface ChatMessageRecord {
  readonly id: string
  readonly conversationId: string
  readonly seq: number
  readonly role: ChatRole
  readonly content: string
  readonly createdAt: number
  readonly toolCalls: number
  readonly toolCallLimitReached: boolean
  readonly readOnly: boolean
  readonly inputTokens: number
  readonly outputTokens: number
  readonly stopReason: string | null
  readonly error: string | null
  readonly changes: readonly ChatChangeRecord[]
  readonly confirmations: readonly ChatConfirmationRecord[]
}

export interface Transcript {
  readonly conversation: Conversation
  readonly messages: readonly ChatMessageRecord[]
}

const conversationColumns = 'id, title, created_at, updated_at'

const messageColumns = `id, conversation_id, seq, role, content, created_at, tool_calls,
  tool_call_limit_reached, read_only, input_tokens, output_tokens, stop_reason, error`

const changeColumns = `id, message_id, position, tool, summary, entity, entity_id, inverse,
  created_at, undone_at`

const confirmationColumns = `id, message_id, reason, tool, arguments, affected_count, summary,
  created_at, decided_at, decision`

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/** The title, from the first thing the user said. Cut on a word where there is one to cut on. */
export function conversationTitle(firstMessage: string): string {
  const single = firstMessage.replace(/\s+/g, ' ').trim()
  if (single === '') return 'Untitled conversation'
  if (single.length <= CONVERSATION_TITLE_MAX) return single

  const cut = single.slice(0, CONVERSATION_TITLE_MAX)
  const lastSpace = cut.lastIndexOf(' ')
  // A title cut mid-word reads as a typo, but a title cut back to nothing reads as a bug, so
  // the word boundary is only used where it leaves most of the line.
  return `${lastSpace > CONVERSATION_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut}…`
}

export interface CreateConversationInput {
  /** Supply one to make a test deterministic; otherwise a uuid is generated. */
  readonly id?: string
  readonly title: string
}

export function createConversation(
  database: Database,
  input: CreateConversationInput,
  now: number,
): Conversation {
  const id = input.id ?? randomUUID()

  database
    .prepare(
      `insert into chat_conversations (${conversationColumns})
       values (:id, :title, :created_at, :updated_at)`,
    )
    .run({ id, title: input.title, created_at: now, updated_at: now })

  return { id, title: input.title, createdAt: now, updatedAt: now, ...noUsage }
}

const noUsage = { messageCount: 0, inputTokens: 0, outputTokens: 0 }

/**
 * The conversation, with its message count and token usage read from its messages rather than
 * kept as running totals on the row. One query either way, and two places holding the same
 * number is how the two come to disagree.
 */
export function getConversation(database: Database, id: string): Conversation | null {
  const row = database
    .prepare(
      `select ${conversationColumns
        .split(', ')
        .map((column) => `chat_conversations.${column}`)
        .join(', ')},
         (select count(*) from chat_messages where conversation_id = chat_conversations.id)
           as message_count,
         (select coalesce(sum(input_tokens), 0) from chat_messages
           where conversation_id = chat_conversations.id) as input_tokens,
         (select coalesce(sum(output_tokens), 0) from chat_messages
           where conversation_id = chat_conversations.id) as output_tokens
       from chat_conversations where chat_conversations.id = ?`,
    )
    .get(id)

  return row === undefined ? null : toConversation(row as Row)
}

function toConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: Number(row.message_count ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
  }
}

/** Most recently used first, which is the order a conversation is looked for in. */
export function listConversations(database: Database, limit = 50): Conversation[] {
  return database
    .prepare(
      `select chat_conversations.id, chat_conversations.title, chat_conversations.created_at,
         chat_conversations.updated_at,
         (select count(*) from chat_messages where conversation_id = chat_conversations.id)
           as message_count,
         (select coalesce(sum(input_tokens), 0) from chat_messages
           where conversation_id = chat_conversations.id) as input_tokens,
         (select coalesce(sum(output_tokens), 0) from chat_messages
           where conversation_id = chat_conversations.id) as output_tokens
       from chat_conversations
       order by chat_conversations.updated_at desc, chat_conversations.id
       limit ?`,
    )
    .all(limit)
    .map((row) => toConversation(row as Row))
}

export interface AppendMessageInput {
  readonly conversationId: string
  readonly role: ChatRole
  readonly content: string
  readonly id?: string
}

/**
 * Adds a turn and moves the conversation's own timestamp with it, in one transaction: a
 * conversation whose last message is newer than its `updated_at` would sort into the wrong
 * place in the list.
 *
 * The sequence number is allocated here rather than by the caller. There is one writer, so
 * `max + 1` inside the transaction is enough, and the unique index is what says so.
 */
export function appendMessage(
  database: Database,
  input: AppendMessageInput,
  now: number,
): ChatMessageRecord {
  const id = input.id ?? randomUUID()

  return withTransaction(database, () => {
    const seq =
      Number(
        (
          database
            .prepare(
              'select coalesce(max(seq), 0) as top from chat_messages where conversation_id = ?',
            )
            .get(input.conversationId) as Row
        ).top,
      ) + 1

    database
      .prepare(
        `insert into chat_messages (id, conversation_id, seq, role, content, created_at)
         values (:id, :conversation_id, :seq, :role, :content, :created_at)`,
      )
      .run({
        id,
        conversation_id: input.conversationId,
        seq,
        role: input.role,
        content: input.content,
        created_at: now,
      })

    database
      .prepare('update chat_conversations set updated_at = ? where id = ?')
      .run(now, input.conversationId)

    return messageOrThrow(database, id)
  })
}

export interface FinishMessageInput {
  readonly content: string
  readonly toolCalls: number
  readonly toolCallLimitReached: boolean
  readonly readOnly: boolean
  readonly inputTokens: number
  readonly outputTokens: number
  readonly stopReason: string | null
  readonly error: string | null
}

/**
 * Fills in an assistant turn once it is over. The row is written empty when the turn starts, so
 * that the changes and confirmations it produces have something to belong to and so a
 * conversation whose connection dropped part-way is still there to reopen (spec 08, criterion
 * 7). This is the other half of that: what was said, what it cost, and how it ended.
 */
export function finishMessage(
  database: Database,
  id: string,
  input: FinishMessageInput,
  now: number,
): ChatMessageRecord {
  return withTransaction(database, () => {
    const updated = database
      .prepare(
        `update chat_messages set content = :content, tool_calls = :tool_calls,
           tool_call_limit_reached = :limit_reached, read_only = :read_only,
           input_tokens = :input_tokens, output_tokens = :output_tokens,
           stop_reason = :stop_reason, error = :error
         where id = :id and role = 'assistant'`,
      )
      .run({
        id,
        content: input.content,
        tool_calls: input.toolCalls,
        limit_reached: booleanToInteger(input.toolCallLimitReached),
        read_only: booleanToInteger(input.readOnly),
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        stop_reason: input.stopReason,
        error: input.error,
      }).changes

    // Nothing matched, so either there is no such turn or it is a user message. Both are bugs in
    // the caller, and a silent no-op would leave a turn that says nothing and cost nothing.
    if (updated === 0) {
      throw new Error(`there is no assistant turn ${id} to finish`)
    }

    const message = messageOrThrow(database, id)
    database
      .prepare('update chat_conversations set updated_at = ? where id = ?')
      .run(now, message.conversationId)

    return messageOrThrow(database, id)
  })
}

export function getMessage(database: Database, id: string): ChatMessageRecord | null {
  const row = database.prepare(`select ${messageColumns} from chat_messages where id = ?`).get(id)
  return row === undefined ? null : toMessage(database, row as Row)
}

function messageOrThrow(database: Database, id: string): ChatMessageRecord {
  const message = getMessage(database, id)
  // The row was written in this transaction, so its absence is a bug rather than a case.
  if (message === null) throw new Error(`chat message ${id} vanished as it was written`)
  return message
}

function toMessage(database: Database, row: Row): ChatMessageRecord {
  const id = String(row.id)

  return {
    id,
    conversationId: String(row.conversation_id),
    seq: Number(row.seq),
    role: String(row.role) as ChatRole,
    content: String(row.content),
    createdAt: Number(row.created_at),
    toolCalls: Number(row.tool_calls),
    toolCallLimitReached: Number(row.tool_call_limit_reached) !== 0,
    readOnly: Number(row.read_only) !== 0,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    stopReason: nullableText(row.stop_reason),
    error: nullableText(row.error),
    changes: listChanges(database, id),
    confirmations: listConfirmations(database, id),
  }
}

/** The whole conversation, in order. What reopening one shows. Spec 07, criterion 8. */
export function getTranscript(database: Database, conversationId: string): Transcript | null {
  const conversation = getConversation(database, conversationId)
  if (conversation === null) return null

  const messages = database
    .prepare(`select ${messageColumns} from chat_messages where conversation_id = ? order by seq`)
    .all(conversationId)
    .map((row) => toMessage(database, row as Row))

  return { conversation, messages }
}

/**
 * The turns a new turn is given as context, oldest first. Bounded by the caller, because what a
 * turn can afford to carry is a configuration question and not this layer's.
 *
 * Only what was said: an assistant turn that failed is still part of the conversation, and its
 * text goes back with the rest.
 */
export function contextMessages(
  database: Database,
  conversationId: string,
  limit: number,
): ChatMessageRecord[] {
  return database
    .prepare(
      `select ${messageColumns} from chat_messages
       where conversation_id = ?
       order by seq desc
       limit ?`,
    )
    .all(conversationId, limit)
    .map((row) => toMessage(database, row as Row))
    .reverse()
}

export interface RecordChangeInput {
  readonly messageId: string
  readonly tool: string
  readonly summary: string
  readonly entity: ChatChangeEntity
  readonly entityId: string | null
  /** Null where there is nothing to put back. Redrawing a plan is the case that is. */
  readonly inverse: readonly ChatInverse[] | null
}

export function recordChange(
  database: Database,
  input: RecordChangeInput,
  now: number,
): ChatChangeRecord {
  const id = randomUUID()

  return withTransaction(database, () => {
    const position =
      Number(
        (
          database
            .prepare(
              'select coalesce(max(position), 0) as top from chat_changes where message_id = ?',
            )
            .get(input.messageId) as Row
        ).top,
      ) + 1

    database
      .prepare(
        `insert into chat_changes (${changeColumns}) values (
           :id, :message_id, :position, :tool, :summary, :entity, :entity_id, :inverse,
           :created_at, null
         )`,
      )
      .run({
        id,
        message_id: input.messageId,
        position,
        tool: input.tool,
        summary: input.summary,
        entity: input.entity,
        entity_id: input.entityId,
        inverse: input.inverse === null ? null : JSON.stringify(input.inverse),
        created_at: now,
      })

    return changeOrThrow(database, id)
  })
}

function toChange(row: Row): ChatChangeRecord {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    position: Number(row.position),
    tool: String(row.tool),
    summary: String(row.summary),
    entity: String(row.entity) as ChatChangeEntity,
    entityId: nullableText(row.entity_id),
    createdAt: Number(row.created_at),
    undoneAt: nullableNumber(row.undone_at),
    undoable: nullableText(row.inverse) !== null,
  }
}

export function listChanges(database: Database, messageId: string): ChatChangeRecord[] {
  return database
    .prepare(`select ${changeColumns} from chat_changes where message_id = ? order by position`)
    .all(messageId)
    .map((row) => toChange(row as Row))
}

function changeOrThrow(database: Database, id: string): ChatChangeRecord {
  const row = database.prepare(`select ${changeColumns} from chat_changes where id = ?`).get(id)
  if (row === undefined) throw new Error(`chat change ${id} vanished as it was written`)
  return toChange(row as Row)
}

/**
 * The inverse operations of a turn, in the order they were recorded, along with which change
 * each belongs to. Read only by undo, which is why the inverse is not on `ChatChangeRecord`:
 * nothing else has any business with it.
 */
export interface StoredInverse {
  readonly changeId: string
  readonly position: number
  readonly operations: readonly ChatInverse[]
}

export function inversesFor(database: Database, messageId: string): StoredInverse[] {
  return database
    .prepare(
      `select id, position, inverse from chat_changes
       where message_id = ? and inverse is not null and undone_at is null
       order by position`,
    )
    .all(messageId)
    .flatMap((raw) => {
      const row = raw as Row
      const inverse = nullableText(row.inverse)
      if (inverse === null) return []

      return [
        {
          changeId: String(row.id),
          position: Number(row.position),
          operations: JSON.parse(inverse) as ChatInverse[],
        },
      ]
    })
}

/**
 * The most recent turn of a conversation that changed anything and has not been undone. Undo works
 * on this one only: spec 07 offers it for the last mutation batch, and an older batch's inverse
 * holds values from before whatever happened after it.
 *
 * "Most recent" is by when the change happened rather than by where the turn sits in the
 * conversation, because a confirmation carries its changes back to the turn that proposed it: a
 * held batch confirmed after a later turn has spoken is the newest set of writes, even though its
 * turn is not the newest message. Ordering by `seq` would offer undo on the wrong batch and leave
 * the confirmed one unundoable for good.
 */
export function lastChangedMessageId(database: Database, conversationId: string): string | null {
  const row = database
    .prepare(
      `select chat_messages.id as id, max(chat_changes.created_at) as changed_at
       from chat_messages
       join chat_changes on chat_changes.message_id = chat_messages.id
       where chat_messages.conversation_id = ?
         and chat_changes.inverse is not null
         and chat_changes.undone_at is null
       group by chat_messages.id
       order by changed_at desc, chat_messages.seq desc
       limit 1`,
    )
    .get(conversationId)

  return row === undefined ? null : String((row as Row).id)
}

/** Marks a change undone. Guarded on it not already being, so a double undo does nothing. */
export function markChangeUndone(database: Database, id: string, at: number): boolean {
  return (
    database
      .prepare('update chat_changes set undone_at = ? where id = ? and undone_at is null')
      .run(at, id).changes > 0
  )
}

export interface CreateConfirmationInput {
  readonly messageId: string
  readonly reason: ChatConfirmationReason
  readonly tool: string
  readonly arguments: unknown
  readonly affectedCount: number
  readonly summary: string
}

export function createConfirmation(
  database: Database,
  input: CreateConfirmationInput,
  now: number,
): ChatConfirmationRecord {
  const id = randomUUID()

  database
    .prepare(
      `insert into chat_confirmations (${confirmationColumns}) values (
         :id, :message_id, :reason, :tool, :arguments, :affected_count, :summary, :created_at,
         null, null
       )`,
    )
    .run({
      id,
      message_id: input.messageId,
      reason: input.reason,
      tool: input.tool,
      arguments: JSON.stringify(input.arguments ?? {}),
      affected_count: input.affectedCount,
      summary: input.summary,
      created_at: now,
    })

  return confirmationOrThrow(database, id)
}

/**
 * Adds to a confirmation that has not been decided yet. One turn's bulk operations are one
 * confirmation, so that what the user is shown is "this would change fourteen tasks" and not
 * fourteen prompts in a row: criterion 4 asks the confirmation state how many items are affected,
 * which is a fact about the batch. Refuses a decided row, so a race cannot append to something
 * that has already run.
 */
export function extendConfirmation(
  database: Database,
  id: string,
  input: {
    readonly arguments: unknown
    readonly affectedCount: number
    readonly summary: string
  },
): ChatConfirmationRecord | null {
  const changed = database
    .prepare(
      `update chat_confirmations
       set arguments = ?, affected_count = ?, summary = ?
       where id = ? and decided_at is null`,
    )
    .run(JSON.stringify(input.arguments ?? {}), input.affectedCount, input.summary, id).changes

  return changed === 0 ? null : confirmationOrThrow(database, id)
}

function toConfirmation(row: Row): ChatConfirmationRecord {
  const args = nullableText(row.arguments)

  return {
    id: String(row.id),
    messageId: String(row.message_id),
    reason: String(row.reason) as ChatConfirmationReason,
    tool: String(row.tool),
    arguments: args === null ? {} : (JSON.parse(args) as unknown),
    affectedCount: Number(row.affected_count),
    summary: String(row.summary),
    createdAt: Number(row.created_at),
    decidedAt: nullableNumber(row.decided_at),
    decision: nullableText(row.decision) as ChatConfirmationDecision | null,
  }
}

export function getConfirmation(database: Database, id: string): ChatConfirmationRecord | null {
  const row = database
    .prepare(`select ${confirmationColumns} from chat_confirmations where id = ?`)
    .get(id)

  return row === undefined ? null : toConfirmation(row as Row)
}

function confirmationOrThrow(database: Database, id: string): ChatConfirmationRecord {
  const confirmation = getConfirmation(database, id)
  if (confirmation === null) throw new Error(`chat confirmation ${id} vanished as it was written`)
  return confirmation
}

export function listConfirmations(database: Database, messageId: string): ChatConfirmationRecord[] {
  return database
    .prepare(
      `select ${confirmationColumns} from chat_confirmations
       where message_id = ? order by created_at, id`,
    )
    .all(messageId)
    .map((row) => toConfirmation(row as Row))
}

/**
 * Records the decision. Guarded on the row being undecided, so a second confirmation of the
 * same delete cannot run it twice: the caller checks the return before performing anything.
 */
export function decideConfirmation(
  database: Database,
  id: string,
  decision: ChatConfirmationDecision,
  at: number,
): boolean {
  return (
    database
      .prepare(
        `update chat_confirmations set decision = ?, decided_at = ?
         where id = ? and decided_at is null`,
      )
      .run(decision, at, id).changes > 0
  )
}
