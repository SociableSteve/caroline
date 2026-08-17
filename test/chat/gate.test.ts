import { describe, expect, it } from 'vitest'
import { describeCall, gateWrite } from '../../src/chat/gate.js'
import type { ChatToolContext } from '../../src/chat/types.js'
import {
  appendMessage,
  createConfirmation,
  createConversation,
} from '../../src/db/repositories/chat.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { testConfig } from '../helpers/test-server.js'

// The fallback path never reads `context`, `create_task` and `update_task` have no `describe` of
// their own, so this exercises exactly the branch a titled write tool without one falls into.
const context = {} as ChatToolContext

const NOW = Date.UTC(2026, 5, 1, 9, 0, 0)

describe('describeCall', () => {
  it('names a titled tool without a custom describe by its title, in curly quotes', () => {
    const tool = { name: 'create_task' }
    const call = { arguments: { title: 'Renew the certificate' } }

    expect(describeCall(context, tool, call)).toBe('create_task: “Renew the certificate”')
  })
})

describe('gateWrite', () => {
  const tool = { name: 'complete_task', touchesTasks: true }

  /**
   * A bulk confirmation decided (by a concurrent `/confirm` call, say) between the accumulator
   * being read and this write reaching the gate: `extendConfirmation` finds no undecided row to
   * extend, and the gate answers with the confirmation as it already stood, marked `stale` so a
   * caller emitting a `confirmation` event off every held outcome knows not to re-announce a
   * decision this call did not make. Regression test for the bug where `hold()` in `turn.ts`
   * re-emitted the SSE event in exactly this case.
   */
  it('marks the outcome stale when the bulk confirmation it would extend was already decided', () => {
    const database = migratedDatabase()
    const conversation = createConversation(database, { title: 'Test' }, NOW)
    const turn = appendMessage(
      database,
      { conversationId: conversation.id, role: 'assistant', content: '' },
      NOW,
    )
    const confirmation = createConfirmation(
      database,
      {
        messageId: turn.id,
        reason: 'bulk',
        tool: tool.name,
        arguments: { operations: [] },
        affectedCount: 1,
        summary: 'held',
      },
      NOW,
    )
    database
      .prepare("update chat_confirmations set decision = 'confirmed', decided_at = ? where id = ?")
      .run(NOW, confirmation.id)

    const accumulator = {
      mutatedTaskIds: new Set(['task-1', 'task-2']),
      bulkConfirmation: { record: confirmation, operations: [], descriptions: ['held'] },
    }

    const outcome = gateWrite(
      {
        database,
        config: { ...testConfig, chat: { ...testConfig.chat, bulkConfirmThreshold: 2 } },
        now: NOW,
      } as ChatToolContext,
      tool,
      { arguments: { id: 'task-3' } },
      turn.id,
      accumulator,
    )

    expect(outcome).toMatchObject({ held: true, stale: true })
  })

  it('does not mark a freshly held or extended confirmation stale', () => {
    const database = migratedDatabase()
    const conversation = createConversation(database, { title: 'Test' }, NOW)
    const turn = appendMessage(
      database,
      { conversationId: conversation.id, role: 'assistant', content: '' },
      NOW,
    )

    const accumulator = {
      mutatedTaskIds: new Set(['task-1']),
      bulkConfirmation: null,
    }

    const outcome = gateWrite(
      {
        database,
        config: { ...testConfig, chat: { ...testConfig.chat, bulkConfirmThreshold: 1 } },
        now: NOW,
      } as ChatToolContext,
      tool,
      { arguments: { id: 'task-2' } },
      turn.id,
      accumulator,
    )

    expect(outcome).toMatchObject({ held: true })
    if (outcome.held) expect(outcome.stale).not.toBe(true)
  })
})
