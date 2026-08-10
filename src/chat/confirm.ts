/**
 * Carrying out what the user confirmed, or recording that they did not. Spec 07: the model
 * proposes, the user confirms, and only then does anything happen.
 *
 * The operations run through the same `executeTool` the turn loop uses, against the same turn, so a
 * confirmed delete is recorded and undoable exactly as an ordinary change is. Deciding is guarded
 * in the database rather than here: `decideConfirmation` refuses a row that has been decided, so
 * two clicks on Confirm cannot delete the same task twice.
 */
import {
  decideConfirmation,
  getConfirmation,
  type ChatChangeRecord,
  type ChatConfirmationRecord,
} from '../db/repositories/chat.js'
import { executeTool } from './execute.js'
import type { ToolRegistry } from './registry.js'
import type { ChatToolContext } from './types.js'

export interface ConfirmationOperation {
  readonly tool: string
  readonly arguments: unknown
}

/** What was proposed, read back out of the stored arguments. */
export function operationsOf(confirmation: ChatConfirmationRecord): ConfirmationOperation[] {
  const stored = confirmation.arguments
  if (stored === null || typeof stored !== 'object') return []

  const operations = (stored as { operations?: unknown }).operations
  if (!Array.isArray(operations)) return []

  return operations.flatMap((raw) => {
    if (raw === null || typeof raw !== 'object') return []
    const operation = raw as { tool?: unknown; arguments?: unknown }
    return typeof operation.tool === 'string'
      ? [{ tool: operation.tool, arguments: operation.arguments }]
      : []
  })
}

export type ConfirmResult =
  | {
      readonly resolved: true
      readonly confirmation: ChatConfirmationRecord
      readonly changes: readonly ChatChangeRecord[]
      /** What could not be carried out, in the words the user should see. */
      readonly failures: readonly string[]
      readonly changedData: boolean
    }
  | { readonly resolved: false; readonly reason: 'no-such-confirmation' | 'already-decided' }

/**
 * Confirms or rejects. A rejection performs nothing and is recorded, because "the user said no" is
 * a decision worth keeping: without it a confirmation nobody acted on and one that was refused
 * would look the same on reopening the conversation.
 */
export async function resolveConfirmation(
  context: ChatToolContext,
  registry: ToolRegistry,
  id: string,
  confirmed: boolean,
): Promise<ConfirmResult> {
  const confirmation = getConfirmation(context.database, id)
  if (confirmation === null) return { resolved: false, reason: 'no-such-confirmation' }
  if (confirmation.decidedAt !== null) return { resolved: false, reason: 'already-decided' }

  if (
    !decideConfirmation(context.database, id, confirmed ? 'confirmed' : 'rejected', context.now)
  ) {
    // Somebody else decided it between the read and the write. Not an error worth a stack: it is
    // the same answer as finding it decided a moment earlier.
    return { resolved: false, reason: 'already-decided' }
  }

  if (!confirmed) {
    return {
      resolved: true,
      confirmation: getConfirmation(context.database, id) ?? confirmation,
      changes: [],
      failures: [],
      changedData: false,
    }
  }

  const changes: ChatChangeRecord[] = []
  const failures: string[] = []

  for (const operation of operationsOf(confirmation)) {
    const tool = registry.get(operation.tool)
    if (tool === undefined) {
      failures.push(`${operation.tool} is no longer available, so it was not carried out.`)
      continue
    }

    // Every operation is attempted. One that cannot be carried out any more, because the task has
    // since been deleted or completed elsewhere, is reported and the rest still run: a batch the
    // user confirmed is a batch they want, not an all-or-nothing gesture.
    //
    // A throw is caught for a harder reason. The row is already decided, so letting it escape would
    // answer 500 against a confirmation that can never be retried and say nothing about what did
    // run. Reported as a failure, it reaches the user as the sentence it is.
    try {
      const result = await executeTool(context, tool, operation.arguments, confirmation.messageId)
      if (result.ok) changes.push(...result.changes)
      else failures.push(result.message)
    } catch (error) {
      failures.push(
        `${operation.tool} could not be carried out: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    resolved: true,
    confirmation: getConfirmation(context.database, id) ?? confirmation,
    changes,
    failures,
    changedData: changes.length > 0,
  }
}
