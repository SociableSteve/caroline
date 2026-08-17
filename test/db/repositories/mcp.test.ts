/**
 * The MCP session store, against a real migrated database. Spec 12: a session is found by the
 * client's declared name and continued within the idle window, and its open turn is rebuilt from
 * the database on every call rather than kept in memory, because a session's calls are separate
 * requests.
 */
import { describe, expect, it } from 'vitest'
import {
  appendMessage,
  getConversation,
  createConfirmation,
} from '../../../src/db/repositories/chat.js'
import {
  findOrCreateSession,
  recordMcpCall,
  saveSessionAccumulator,
  openSessionTurn,
  listMcpCalls,
} from '../../../src/db/repositories/mcp.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const NOW = Date.UTC(2026, 5, 1, 9, 0, 0)
const MINUTE = 60_000

describe('findOrCreateSession', () => {
  it('creates a new MCP conversation for a first call', () => {
    const database = migratedDatabase()
    const session = findOrCreateSession(
      database,
      { clientName: 'review-bot', sessionIdleMinutes: 30 },
      NOW,
    )

    expect(session.clientName).toBe('review-bot')
    expect(getConversation(database, session.conversationId)).toMatchObject({
      source: 'mcp',
      clientName: 'review-bot',
    })
  })

  it('continues the same session for the same client within the idle window', () => {
    const database = migratedDatabase()
    const first = findOrCreateSession(
      database,
      { clientName: 'review-bot', sessionIdleMinutes: 30 },
      NOW,
    )
    const second = findOrCreateSession(
      database,
      { clientName: 'review-bot', sessionIdleMinutes: 30 },
      NOW + 10 * MINUTE,
    )

    expect(second.id).toBe(first.id)
  })

  it('starts a new session after a gap longer than the idle window', () => {
    const database = migratedDatabase()
    const first = findOrCreateSession(
      database,
      { clientName: 'review-bot', sessionIdleMinutes: 30 },
      NOW,
    )
    const second = findOrCreateSession(
      database,
      { clientName: 'review-bot', sessionIdleMinutes: 30 },
      NOW + 31 * MINUTE,
    )

    expect(second.id).not.toBe(first.id)
  })

  it('attributes a request with no declared client name to an unnamed client rather than refusing it', () => {
    const database = migratedDatabase()
    const session = findOrCreateSession(database, { clientName: null, sessionIdleMinutes: 30 }, NOW)

    expect(session.clientName).toBeNull()
    expect(getConversation(database, session.conversationId)?.clientName).toBeNull()
  })

  it('does not merge two differently named clients into one session', () => {
    const database = migratedDatabase()
    const first = findOrCreateSession(database, { clientName: 'a', sessionIdleMinutes: 30 }, NOW)
    const second = findOrCreateSession(database, { clientName: 'b', sessionIdleMinutes: 30 }, NOW)

    expect(second.id).not.toBe(first.id)
  })
})

describe('openSessionTurn', () => {
  it('starts empty, with no turn open, for a fresh session', () => {
    const database = migratedDatabase()
    const session = findOrCreateSession(database, { clientName: 'a', sessionIdleMinutes: 30 }, NOW)

    const open = openSessionTurn(database, session.id)

    expect(open.turnMessageId).toBeNull()
    expect(open.accumulator.mutatedTaskIds.size).toBe(0)
    expect(open.accumulator.bulkConfirmation).toBeNull()
  })

  it('round-trips a saved turn back into an accumulator', () => {
    const database = migratedDatabase()
    const session = findOrCreateSession(database, { clientName: 'a', sessionIdleMinutes: 30 }, NOW)
    const turn = appendMessage(
      database,
      { conversationId: session.conversationId, role: 'assistant', content: '' },
      NOW,
    )

    saveSessionAccumulator(database, session.id, turn.id, {
      mutatedTaskIds: new Set(['task-1', 'task-2']),
      bulkConfirmation: null,
    })

    const open = openSessionTurn(database, session.id)
    expect(open.turnMessageId).toBe(turn.id)
    expect(open.accumulator.mutatedTaskIds).toEqual(new Set(['task-1', 'task-2']))
  })

  /** Spec 07, criterion 14: once a confirmation is decided, the next write opens a new turn. */
  it('clears the accumulator and the open turn once the open confirmation has been decided', () => {
    const database = migratedDatabase()
    const session = findOrCreateSession(database, { clientName: 'a', sessionIdleMinutes: 30 }, NOW)
    const turn = appendMessage(
      database,
      { conversationId: session.conversationId, role: 'assistant', content: '' },
      NOW,
    )

    const confirmation = createConfirmation(
      database,
      {
        messageId: turn.id,
        reason: 'bulk',
        tool: 'update_task',
        arguments: { operations: [{ tool: 'update_task', arguments: { id: 'task-11' } }] },
        affectedCount: 1,
        summary: 'held',
      },
      NOW,
    )

    saveSessionAccumulator(database, session.id, turn.id, {
      mutatedTaskIds: new Set(Array.from({ length: 10 }, (_, index) => `task-${index}`)),
      bulkConfirmation: { record: confirmation, operations: [], descriptions: ['held'] },
    })

    // Not yet decided: the accumulator still carries what was there.
    expect(openSessionTurn(database, session.id).accumulator.mutatedTaskIds.size).toBe(10)

    database
      .prepare("update chat_confirmations set decided_at = ?, decision = 'confirmed' where id = ?")
      .run(NOW, confirmation.id)

    const cleared = openSessionTurn(database, session.id)
    expect(cleared.turnMessageId).toBeNull()
    expect(cleared.accumulator.mutatedTaskIds.size).toBe(0)
    expect(cleared.accumulator.bulkConfirmation).toBeNull()
  })
})

describe('recordMcpCall', () => {
  it('records one row per call, holding no answered item text', () => {
    const database = migratedDatabase()
    const session = findOrCreateSession(database, { clientName: 'a', sessionIdleMinutes: 30 }, NOW)

    recordMcpCall(
      database,
      {
        sessionId: session.id,
        tool: 'search_tasks',
        argumentsDigest: 'digest-1',
        held: false,
        contentLevel: 'snippet',
        policyVersion: '2026-01-01.1',
        itemCount: 3,
      },
      NOW,
    )

    const calls = listMcpCalls(database, session.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      tool: 'search_tasks',
      argumentsDigest: 'digest-1',
      held: false,
      itemCount: 3,
    })
  })
})
