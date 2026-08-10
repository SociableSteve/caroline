/**
 * Running one tool call and recording what it did. Shared by the turn loop, which runs the calls a
 * model made, and by the confirmation route, which runs the ones it was not allowed to: an
 * operation the user confirms has to have exactly the effect it would have had, including the
 * record and the inverse, or undo would not cover it.
 */
import { recordChange, type ChatChangeRecord } from '../db/repositories/chat.js'
import { validateAgainstSchema } from '../llm/validate.js'
import type { ChatTool, ChatToolContext, ToolOutcome } from './types.js'

/** One call as it is proposed or performed: the tool by name, and the arguments it validated. */
export interface ToolCallRequest {
  readonly tool: string
  readonly arguments: unknown
}

export type ExecutionResult =
  | {
      readonly ok: true
      readonly data: unknown
      readonly changes: readonly ChatChangeRecord[]
      /** The tasks it touched, which is what the turn's bulk count is counted over. */
      readonly taskIds: readonly string[]
    }
  | { readonly ok: false; readonly message: string }

/**
 * The arguments, checked against the tool's schema. Spec 07 asks for this before execution, and it
 * happens before the confirmation gate too: an operation held for the user to confirm has to be one
 * that could actually run, or the confirmation would be a promise nothing can keep.
 *
 * A failure is text for the model rather than an exception, because the model is the one that can
 * do something about it: spec 07's "a malformed call returns a structured error to the model".
 */
export function argumentsProblem(tool: ChatTool, args: unknown): string | null {
  const outcome = validateAgainstSchema(tool.parameters, args)
  if (outcome.valid) return null

  return `The arguments for ${tool.name} did not match its schema: ${outcome.message}. Call it again with arguments that do.`
}

/** Validates the arguments and, if they are good, runs the tool and records its changes. */
export async function executeTool(
  context: ChatToolContext,
  tool: ChatTool,
  args: unknown,
  /** The turn the changes belong to. Undo works a turn at a time. */
  messageId: string,
): Promise<ExecutionResult> {
  const problem = argumentsProblem(tool, args)
  if (problem !== null) return { ok: false, message: problem }

  const answer: ToolOutcome = await tool.execute(context, args)
  if (!answer.ok) return { ok: false, message: answer.message }

  const changes = (answer.mutations ?? []).map((mutation) =>
    recordChange(
      context.database,
      {
        messageId,
        tool: tool.name,
        summary: mutation.summary,
        entity: mutation.entity,
        entityId: mutation.entityId,
        inverse: mutation.inverse,
      },
      context.now,
    ),
  )

  return {
    ok: true,
    data: answer.data,
    changes,
    taskIds: (answer.mutations ?? []).flatMap((mutation) => [...mutation.taskIds]),
  }
}
