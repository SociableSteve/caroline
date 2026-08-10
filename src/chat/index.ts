/**
 * Chat, assembled. One place builds the turn loop, the tool registry and the two things that can be
 * done to a finished turn, so the routes ask for a capability rather than wiring the parts up
 * themselves. Spec 07.
 */
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import type { LlmRuntime } from '../llm/index.js'
import type { ChangeFeed } from '../server/changes.js'
import { resolveConfirmation, type ConfirmResult } from './confirm.js'
import { buildToolRegistry } from './registry.js'
import { runTurn, type ChatEmit, type TurnInput, type TurnRefusal } from './turn.js'
import type { ChatToolContext, PlanRegeneration } from './types.js'
import { undoTurn, type UndoResult } from './undo.js'

export type { ChatEvent, ChatEmit } from './turn.js'
export type { PlanRegeneration } from './types.js'

export interface ChatServiceOptions {
  readonly database: Database
  readonly config: Config
  readonly llm: LlmRuntime
  readonly now: () => number
  readonly calendarConnected: () => boolean
  /** How a plan gets redrawn: through the scheduler, so it is recorded and guarded. Spec 06. */
  readonly regeneratePlan: () => Promise<PlanRegeneration>
  readonly changes?: ChangeFeed
}

export interface ChatService {
  /** Whether a model is configured for chat at all. */
  isConfigured(): boolean
  /**
   * Whether chat can change anything: false when the configured model cannot use tools, which the
   * UI shows as read-only. Spec 07, criterion 7.
   */
  canWrite(): boolean
  /** Runs a turn, reporting it through `emit` as it happens. */
  turn(input: TurnInput, emit: ChatEmit): Promise<TurnRefusal | null>
  confirm(id: string, confirmed: boolean): Promise<ConfirmResult>
  undo(conversationId: string, messageId: string): UndoResult
}

export function createChatService(options: ChatServiceOptions): ChatService {
  const toolContext = (): ChatToolContext => ({
    database: options.database,
    config: options.config,
    now: options.now(),
    calendarConnected: options.calendarConnected,
    regeneratePlan: options.regeneratePlan,
  })

  const canWrite = (): boolean =>
    options.llm.isConfigured('chat') && options.llm.for('chat').supportsTools

  return {
    isConfigured: () => options.llm.isConfigured('chat'),
    canWrite,

    turn: (input, emit) => runTurn(options, input, emit),

    async confirm(id, confirmed) {
      // The registry a confirmation runs against is the writing one whatever the model can do now:
      // the user confirmed an operation, and the model has no further part in it.
      const result = await resolveConfirmation(
        toolContext(),
        buildToolRegistry({ tools: true }),
        id,
        confirmed,
      )

      if (result.resolved && result.changedData) {
        const at = options.now()
        options.changes?.publish({ kind: 'tasks', at })
        options.changes?.publish({ kind: 'projects', at })
      }

      return result
    },

    undo(conversationId, messageId) {
      const result = undoTurn(options.database, conversationId, messageId, options.now())

      if (result.undone) {
        const at = options.now()
        options.changes?.publish({ kind: 'tasks', at })
        options.changes?.publish({ kind: 'projects', at })
      }

      return result
    },
  }
}
