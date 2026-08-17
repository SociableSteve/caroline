/**
 * The confirmation gate: holds a delete, and holds a turn's writes past the bulk threshold.
 * Extracted from `src/chat/turn.ts` so it is a decision every caller's session makes rather than
 * something the browser turn loop alone knows how to do. Spec 07, criterion 14 and spec 12: an
 * MCP session's writes are gated by the same rule, over a turn that spans many separate JSON-RPC
 * calls instead of one request, so this module knows nothing about either shape and is handed an
 * accumulator to read and update instead.
 *
 * The two gates and their wording are otherwise unchanged from where they lived before.
 */
import { withholdsItemText } from '../config/content.js'
import type { Config } from '../config/schema.js'
import {
  createConfirmation,
  extendConfirmation,
  type ChatConfirmationRecord,
} from '../db/repositories/chat.js'
import type { ChatToolContext } from './types.js'

/** What the gate needs to know about the tool being called. A subset of `ChatTool`. */
export interface GateableTool {
  readonly name: string
  readonly alwaysConfirm?: boolean
  readonly touchesTasks?: boolean
  describe?(context: ChatToolContext, args: unknown): string
}

export interface GateableCall {
  readonly arguments: unknown
}

/**
 * What a session's open turn has done so far, read and written by the gate. A browser turn keeps
 * this in memory for the one request it lives inside (`TurnState` in `turn.ts`); an MCP session
 * keeps it in `mcp_sessions`, because its turn spans many requests. Either way it is the same
 * shape and the gate does not know which.
 */
export interface GateAccumulator {
  mutatedTaskIds: Set<string>
  bulkConfirmation: {
    record: ChatConfirmationRecord
    operations: Array<{ readonly tool: string; readonly arguments: unknown }>
    descriptions: string[]
  } | null
}

export type GateOutcome =
  | { readonly held: false }
  | {
      readonly held: true
      readonly confirmation: ChatConfirmationRecord
      /**
       * What the caller should be told: nothing happened, and a person has been asked. Already
       * shaped by `llmContent` (spec 09, criterion 13): at `none` it names the call by its own
       * arguments rather than by anything read from the database.
       */
      readonly message: string
    }

/**
 * One tool call against a session's open turn: held for a delete, held past the bulk threshold,
 * or not held at all. `turnId` is the message the operation would be recorded against if it runs,
 * and the same one confirming it later replays it against.
 */
export function gateWrite(
  context: ChatToolContext,
  tool: GateableTool,
  call: GateableCall,
  turnId: string,
  accumulator: GateAccumulator,
): GateOutcome {
  const { database, config } = context
  const description = describeCall(context, tool, call)
  /**
   * The same operation as the model may be told it: `describe` reads the row out of the
   * database, so at `none` the caller is told what it asked for by the arguments it asked with
   * instead. The confirmation record keeps the full description, because the card is rendered on
   * the user's own screen from their own database. `llmContent` governs what leaves the machine.
   * Spec 09, criterion 13.
   */
  const told = withholdsItemText(config.privacy)
    ? describeCall(context, tool, call, { fromDatabase: false })
    : description

  if (tool.alwaysConfirm === true) {
    const confirmation = createConfirmation(
      database,
      {
        messageId: turnId,
        reason: 'delete',
        tool: tool.name,
        arguments: { operations: [{ tool: tool.name, arguments: call.arguments }] },
        affectedCount: 1,
        summary: description,
      },
      context.now,
    )

    return {
      held: true,
      confirmation,
      message: `Nothing was deleted. ${told} has been put to the user to confirm, which is how deleting always works here. Do not try again; say what you have proposed and why.`,
    }
  }

  // The threshold counts tasks, so a write that changes none of them is not held by it.
  if (tool.touchesTasks === false) return { held: false }
  if (accumulator.mutatedTaskIds.size < config.chat.bulkConfirmThreshold) return { held: false }

  const operations = [
    ...(accumulator.bulkConfirmation?.operations ?? []),
    { tool: tool.name, arguments: call.arguments },
  ]
  const descriptions = [...(accumulator.bulkConfirmation?.descriptions ?? []), description]
  // What confirming would affect is the held batch, not the turn: the tasks already changed are
  // done, and counting them here would have the card read more items waiting than there are.
  const affectedCount = operations.length
  const summary = bulkSummary(
    accumulator.mutatedTaskIds.size,
    operations.length,
    config,
    descriptions,
  )

  const record =
    accumulator.bulkConfirmation === null
      ? createConfirmation(
          database,
          {
            messageId: turnId,
            reason: 'bulk',
            tool: tool.name,
            arguments: { operations },
            affectedCount,
            summary,
          },
          context.now,
        )
      : extendConfirmation(database, accumulator.bulkConfirmation.record.id, {
          arguments: { operations },
          affectedCount,
          summary,
        })

  // A confirmation that has already been decided cannot be added to, which leaves the operation
  // unheld and unperformed.
  if (record === null) {
    const existing = accumulator.bulkConfirmation
    if (existing === null) {
      // Nothing to point at: the accumulator disagrees with the database about whether this
      // turn has an open confirmation, which is a bug in a caller rather than a case to answer
      // silently for.
      throw new Error('the gate tried to extend a bulk confirmation it has no record of')
    }

    return {
      held: true,
      confirmation: existing.record,
      message:
        'This turn has already changed as many tasks as it may without asking, and the confirmation it was collected into has been decided. Nothing was changed. Ask the user to start a new instruction.',
    }
  }

  accumulator.bulkConfirmation = { record, operations, descriptions }

  return {
    held: true,
    confirmation: record,
    message: `Nothing was changed. This turn has already changed ${accumulator.mutatedTaskIds.size} tasks, which is the point at which the rest of a turn is proposed rather than applied, so ${told} has been put to the user with the others. Carry on with what is left and say what you have proposed.`,
  }
}

function bulkSummary(
  changed: number,
  held: number,
  config: Config,
  descriptions: readonly string[],
): string {
  return `This turn would change ${changed + held} tasks, more than the ${config.chat.bulkConfirmThreshold} it may change without being asked. ${changed} are already done. Confirming applies the remaining ${held}: ${descriptions.join('; ')}.`
}

export function describeCall(
  context: ChatToolContext,
  tool: GateableTool,
  call: GateableCall,
  { fromDatabase = true }: { fromDatabase?: boolean } = {},
): string {
  if (fromDatabase && tool.describe !== undefined) return tool.describe(context, call.arguments)

  // No description of its own, so the call is named by what it addresses. Enough for a person to
  // recognise it, and it never invents a title the arguments did not carry, which is also why it
  // is what a caller is told at `none`: the arguments are its own words coming back.
  const args = (call.arguments ?? {}) as { id?: unknown; title?: unknown }
  if (typeof args.title === 'string') return `${tool.name}: "${args.title}"`
  if (typeof args.id === 'string') return `${tool.name} on ${args.id}`

  return tool.name
}
