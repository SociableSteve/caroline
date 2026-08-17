/**
 * The conversation store, against a real migrated database. Spec 07: conversations persist and are
 * listed so an earlier one can be reopened, each turn carries what it changed, and an operation the
 * user has to confirm is written down rather than held in a request's memory.
 */
import { describe, expect, it } from 'vitest'
import {
  appendMessage,
  contextMessages,
  conversationTitle,
  createConfirmation,
  createConversation,
  decideConfirmation,
  extendConfirmation,
  finishMessage,
  getConfirmation,
  getConversation,
  getTranscript,
  getTurnContext,
  inversesFor,
  lastChangedMessageId,
  listConversations,
  markChangeUndone,
  recordChange,
  recordTurnContext,
} from '../../../src/db/repositories/chat.js'
import type { Database } from '../../../src/db/connection.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const NOW = Date.UTC(2026, 5, 1, 9, 0, 0)
const MINUTE = 60_000

const finished = {
  content: 'Answered.',
  toolCalls: 2,
  toolCallLimitReached: false,
  readOnly: false,
  inputTokens: 100,
  outputTokens: 40,
  stopReason: 'end_turn',
  error: null,
}

function conversation(database: Database, title = 'What is in my inbox?') {
  return createConversation(database, { title }, NOW)
}

describe('conversation source (spec 12)', () => {
  it('defaults an unspecified conversation to browser, with no client name', () => {
    const database = migratedDatabase()
    const created = conversation(database)

    expect(created.source).toBe('browser')
    expect(created.clientName).toBeNull()
    expect(getConversation(database, created.id)).toMatchObject({
      source: 'browser',
      clientName: null,
    })
  })

  it('records an MCP conversation and the client that named it', () => {
    const database = migratedDatabase()
    const created = createConversation(
      database,
      { title: 'MCP session', source: 'mcp', clientName: 'review-bot' },
      NOW,
    )

    expect(created.source).toBe('mcp')
    expect(created.clientName).toBe('review-bot')
    expect(getConversation(database, created.id)).toMatchObject({
      source: 'mcp',
      clientName: 'review-bot',
    })
  })

  it('leaves the client name null for an MCP conversation whose client declared none', () => {
    const database = migratedDatabase()
    const created = createConversation(database, { title: 'MCP session', source: 'mcp' }, NOW)

    expect(created.clientName).toBeNull()
  })

  it('ignores a client name given for a browser conversation', () => {
    const database = migratedDatabase()
    const created = createConversation(
      database,
      { title: 'Browser', source: 'browser', clientName: 'should be ignored' },
      NOW,
    )

    expect(created.clientName).toBeNull()
  })
})

describe('conversationTitle', () => {
  it('takes the first message as it stands when it is short enough', () => {
    expect(conversationTitle('Triage my inbox')).toBe('Triage my inbox')
  })

  it('collapses the whitespace, so a pasted paragraph reads as one line', () => {
    expect(conversationTitle('  Triage\n  my   inbox  ')).toBe('Triage my inbox')
  })

  it('cuts a long message on a word boundary', () => {
    const title = conversationTitle(`${'word '.repeat(30)}end`)

    expect(title.length).toBeLessThanOrEqual(81)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toContain('wor…')
  })

  it('names a message with nothing in it rather than leaving a blank row', () => {
    expect(conversationTitle('   ')).toBe('Untitled conversation')
  })
})

describe('a conversation', () => {
  it('is created empty, and reads back', () => {
    const database = migratedDatabase()
    const created = conversation(database)

    expect(getConversation(database, created.id)).toMatchObject({
      title: 'What is in my inbox?',
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
  })

  it('is null when there is no such id, rather than an empty one', () => {
    expect(getConversation(migratedDatabase(), 'nope')).toBeNull()
  })

  it('counts its messages and adds up its token usage', () => {
    const database = migratedDatabase()
    const created = conversation(database)
    appendMessage(database, { conversationId: created.id, role: 'user', content: 'Hello' }, NOW)
    const turn = appendMessage(
      database,
      { conversationId: created.id, role: 'assistant', content: '' },
      NOW,
    )
    finishMessage(database, turn.id, finished, NOW)

    expect(getConversation(database, created.id)).toMatchObject({
      messageCount: 2,
      inputTokens: 100,
      outputTokens: 40,
    })
  })

  it('numbers its messages from one, in the order they were said', () => {
    const database = migratedDatabase()
    const created = conversation(database)

    appendMessage(database, { conversationId: created.id, role: 'user', content: 'One' }, NOW)
    appendMessage(database, { conversationId: created.id, role: 'assistant', content: 'Two' }, NOW)
    appendMessage(database, { conversationId: created.id, role: 'user', content: 'Three' }, NOW)

    expect(getTranscript(database, created.id)?.messages.map((message) => message.seq)).toEqual([
      1, 2, 3,
    ])
  })

  /** The list is read by what a conversation was about and when it was last used. */
  it('sorts the list by when each was last spoken in', () => {
    const database = migratedDatabase()
    const older = createConversation(database, { title: 'Older' }, NOW)
    const newer = createConversation(database, { title: 'Newer' }, NOW + MINUTE)
    appendMessage(
      database,
      { conversationId: older.id, role: 'user', content: 'Back again' },
      NOW + 2 * MINUTE,
    )

    expect(listConversations(database).map((entry) => entry.title)).toEqual(['Older', 'Newer'])
    expect(getConversation(database, newer.id)?.updatedAt).toBe(NOW + MINUTE)
  })

  it('caps the list at the limit it was given', () => {
    const database = migratedDatabase()
    for (const index of [1, 2, 3]) {
      createConversation(database, { title: `Conversation ${index}` }, NOW + index)
    }

    expect(listConversations(database, 2)).toHaveLength(2)
  })

  it('returns no transcript for an id that names nothing', () => {
    expect(getTranscript(migratedDatabase(), 'nope')).toBeNull()
  })
})

describe('a finished turn', () => {
  it('keeps what was said, what it cost, and how it ended', () => {
    const database = migratedDatabase()
    const created = conversation(database)
    const turn = appendMessage(
      database,
      { conversationId: created.id, role: 'assistant', content: '' },
      NOW,
    )

    const message = finishMessage(
      database,
      turn.id,
      { ...finished, toolCallLimitReached: true },
      NOW + MINUTE,
    )

    expect(message).toMatchObject({
      content: 'Answered.',
      toolCalls: 2,
      toolCallLimitReached: true,
      inputTokens: 100,
      stopReason: 'end_turn',
    })
  })

  it('moves the conversation to the moment it finished, so the list reorders', () => {
    const database = migratedDatabase()
    const created = conversation(database)
    const turn = appendMessage(
      database,
      { conversationId: created.id, role: 'assistant', content: '' },
      NOW,
    )

    finishMessage(database, turn.id, finished, NOW + MINUTE)

    expect(getConversation(database, created.id)?.updatedAt).toBe(NOW + MINUTE)
  })

  /** The system prompt is assembled per turn, so nothing but the two roles is ever stored. */
  it('cannot be a user message carrying usage, which the schema refuses', () => {
    const database = migratedDatabase()
    const created = conversation(database)
    const user = appendMessage(
      database,
      { conversationId: created.id, role: 'user', content: 'Hello' },
      NOW,
    )

    expect(() => finishMessage(database, user.id, finished, NOW)).toThrow(/no assistant turn/i)
  })
})

describe('the context a turn is given', () => {
  it('is the most recent messages, oldest first', () => {
    const database = migratedDatabase()
    const created = conversation(database)
    for (const content of ['One', 'Two', 'Three', 'Four']) {
      appendMessage(database, { conversationId: created.id, role: 'user', content }, NOW)
    }

    expect(contextMessages(database, created.id, 2).map((message) => message.content)).toEqual([
      'Three',
      'Four',
    ])
  })
})

/**
 * The record of what a turn sent about the open item, read back. Spec 07, criterion 10: an audit that
 * says which id was selected is not an audit, so the fields are read as the list of fields they are.
 * A row whose fields cannot be read is an audit missing a line rather than a reason to fail reading
 * the transcript, and a value that parsed to something other than a list of strings would reach the
 * screen, where the fields are joined into a sentence.
 */
describe('what a turn sent about the open item', () => {
  function withContext(fields: string): { database: Database; messageId: string } {
    const database = migratedDatabase()
    const created = conversation(database)
    const turn = appendMessage(
      database,
      { conversationId: created.id, role: 'assistant', content: 'Answered.' },
      NOW,
    )
    recordTurnContext(
      database,
      {
        messageId: turn.id,
        kind: 'task',
        id: 'task-1',
        found: true,
        fields: ['title'],
        contentLevel: 'snippet',
        policyVersion: '2026-08-11',
        rendered: 'Rendered.',
      },
      NOW,
    )
    database
      .prepare('update chat_turn_contexts set fields = ? where message_id = ?')
      .run(fields, turn.id)

    return { database, messageId: turn.id }
  }

  it('reads the fields it wrote', () => {
    const { database, messageId } = withContext('["kind","id","title"]')

    expect(getTurnContext(database, messageId)?.fields).toEqual(['kind', 'id', 'title'])
  })

  it('reads the rest of a turn whose fields are not JSON at all', () => {
    const { database, messageId } = withContext('not json')

    expect(getTurnContext(database, messageId)).toMatchObject({
      fields: [],
      rendered: 'Rendered.',
    })
  })

  it('reads no fields from a value that is not a list', () => {
    const { database, messageId } = withContext('123')

    expect(getTurnContext(database, messageId)?.fields).toEqual([])
  })

  it('keeps the lines of a list that are strings and drops the ones that are not', () => {
    const { database, messageId } = withContext('["title",7,null,"status"]')

    expect(getTurnContext(database, messageId)?.fields).toEqual(['title', 'status'])
  })

  /** The transcript is the reader that must not fail: one unreadable row is not a lost conversation. */
  it('still reads the transcript of a conversation holding a malformed row', () => {
    const { database, messageId } = withContext('{"title":true}')
    const conversationId = getConversation(database, listConversations(database)[0]?.id ?? '')?.id

    const transcript = getTranscript(database, conversationId ?? '')

    expect(transcript?.messages).toHaveLength(1)
    expect(transcript?.messages[0]?.id).toBe(messageId)
    expect(transcript?.messages[0]?.context?.fields).toEqual([])
  })
})

describe('what a turn changed', () => {
  function turnWithChange(database: Database, inverse: boolean = true) {
    const created = conversation(database)
    const turn = appendMessage(
      database,
      { conversationId: created.id, role: 'assistant', content: '' },
      NOW,
    )
    const change = recordChange(
      database,
      {
        messageId: turn.id,
        tool: 'complete_task',
        summary: 'Completed “Book the venue”',
        entity: 'task',
        entityId: 'task-1',
        inverse: inverse ? [{ kind: 'delete-task', id: 'task-1' }] : null,
      },
      NOW,
    )

    return { created, turn, change }
  }

  it('is recorded in the order it happened, and read back with the turn', () => {
    const database = migratedDatabase()
    const { created, turn } = turnWithChange(database)
    recordChange(
      database,
      {
        messageId: turn.id,
        tool: 'create_task',
        summary: 'Created “Draft the agenda” in inbox',
        entity: 'task',
        entityId: 'task-2',
        inverse: [{ kind: 'delete-task', id: 'task-2' }],
      },
      NOW,
    )

    const message = getTranscript(database, created.id)?.messages.at(-1)

    expect(message?.changes.map((change) => [change.position, change.tool])).toEqual([
      [1, 'complete_task'],
      [2, 'create_task'],
    ])
  })

  /** The inverse is for undo and nothing else, so it is not on the record the UI reads. */
  it('says whether it can be undone without publishing how', () => {
    const database = migratedDatabase()
    const { change } = turnWithChange(database, false)

    expect(change.undoable).toBe(false)
    expect(Object.keys(change)).not.toContain('inverse')
  })

  it('offers its inverse operations to undo, in the order they were recorded', () => {
    const database = migratedDatabase()
    const { turn } = turnWithChange(database)

    expect(inversesFor(database, turn.id)).toMatchObject([
      { position: 1, operations: [{ kind: 'delete-task', id: 'task-1' }] },
    ])
  })

  it('stops offering an inverse once it has been undone', () => {
    const database = migratedDatabase()
    const { turn, change } = turnWithChange(database)

    expect(markChangeUndone(database, change.id, NOW + MINUTE)).toBe(true)
    // A second undo of the same change does nothing, so a double click cannot restore twice.
    expect(markChangeUndone(database, change.id, NOW + 2 * MINUTE)).toBe(false)
    expect(inversesFor(database, turn.id)).toEqual([])
  })

  it('is the last turn to have changed something, which is the one undo works on', () => {
    const database = migratedDatabase()
    const { created, turn } = turnWithChange(database)
    // A later turn that changed nothing does not become the undoable one.
    appendMessage(database, { conversationId: created.id, role: 'user', content: 'Thanks' }, NOW)

    expect(lastChangedMessageId(database, created.id)).toBe(turn.id)
  })

  it('has no undoable turn once everything has been put back', () => {
    const database = migratedDatabase()
    const { created, change } = turnWithChange(database)
    markChangeUndone(database, change.id, NOW)

    expect(lastChangedMessageId(database, created.id)).toBeNull()
  })

  it('goes with its turn, since a record of a change nobody can read is not a record', () => {
    const database = migratedDatabase()
    const { created, turn } = turnWithChange(database)

    database.prepare('delete from chat_conversations where id = ?').run(created.id)

    expect(inversesFor(database, turn.id)).toEqual([])
  })
})

describe('a confirmation', () => {
  function pending(database: Database) {
    const created = conversation(database)
    const turn = appendMessage(
      database,
      { conversationId: created.id, role: 'assistant', content: '' },
      NOW,
    )
    const confirmation = createConfirmation(
      database,
      {
        messageId: turn.id,
        reason: 'delete',
        tool: 'delete_task',
        arguments: { operations: [{ tool: 'delete_task', arguments: { id: 'task-1' } }] },
        affectedCount: 1,
        summary: 'Delete “Book the venue”',
      },
      NOW,
    )

    return { created, turn, confirmation }
  }

  it('keeps the arguments the tool validated, so confirming runs what was proposed', () => {
    const database = migratedDatabase()
    const { confirmation } = pending(database)

    expect(getConfirmation(database, confirmation.id)).toMatchObject({
      reason: 'delete',
      affectedCount: 1,
      decision: null,
      decidedAt: null,
      arguments: { operations: [{ tool: 'delete_task', arguments: { id: 'task-1' } }] },
    })
  })

  it('is decided once, so a second confirmation cannot run it twice', () => {
    const database = migratedDatabase()
    const { confirmation } = pending(database)

    expect(decideConfirmation(database, confirmation.id, 'confirmed', NOW + MINUTE)).toBe(true)
    expect(decideConfirmation(database, confirmation.id, 'confirmed', NOW + 2 * MINUTE)).toBe(false)
    expect(getConfirmation(database, confirmation.id)).toMatchObject({
      decision: 'confirmed',
      decidedAt: NOW + MINUTE,
    })
  })

  /** A turn's held operations are one confirmation, so the user is asked once about the batch. */
  it('grows as more of a turn is held', () => {
    const database = migratedDatabase()
    const { confirmation } = pending(database)

    const extended = extendConfirmation(database, confirmation.id, {
      arguments: {
        operations: [
          { tool: 'complete_task', arguments: { id: 'task-1' } },
          { tool: 'complete_task', arguments: { id: 'task-2' } },
        ],
      },
      affectedCount: 12,
      summary: 'This turn would change 12 tasks',
    })

    expect(extended).toMatchObject({
      affectedCount: 12,
      summary: 'This turn would change 12 tasks',
    })
  })

  it('cannot grow once it has been decided', () => {
    const database = migratedDatabase()
    const { confirmation } = pending(database)
    decideConfirmation(database, confirmation.id, 'rejected', NOW)

    expect(
      extendConfirmation(database, confirmation.id, {
        arguments: { operations: [] },
        affectedCount: 2,
        summary: 'Too late',
      }),
    ).toBeNull()
  })

  it('is read back with the turn that proposed it', () => {
    const database = migratedDatabase()
    const { created } = pending(database)

    expect(getTranscript(database, created.id)?.messages.at(-1)?.confirmations).toMatchObject([
      { reason: 'delete', summary: 'Delete “Book the venue”' },
    ])
  })
})
