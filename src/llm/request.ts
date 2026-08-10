/**
 * What every adapter checks before it builds a payload, so the three cannot disagree about
 * which requests are answerable.
 */
import { LlmError, type CompletionRequest } from './types.js'

/**
 * A schema and a set of tools in the same request has no answer that satisfies both.
 *
 * Forcing the structured tool would make the declared tools unreachable; leaving the model
 * free to choose means it may call a tool instead, return no structured output, and fail
 * validation twice over something the caller asked for. Spec 03 keeps the two apart anyway:
 * tools are chat's and structured output is the scheduled jobs'. A caller that genuinely
 * needs both needs turns, not one ambiguous request, and that belongs to chat (spec 07).
 *
 * Refused here rather than left to fail at the provider, so the message names the
 * contradiction instead of describing whatever the model happened to do with it.
 */
export function assertRequestIsAnswerable(request: CompletionRequest): void {
  if (request.schema !== undefined && (request.tools ?? []).length > 0) {
    throw new LlmError(
      'A request cannot ask for both a schema and tools: forcing the structured answer would make the tools unreachable, and leaving the choice open cannot guarantee the schema. Make the tool calls and ask for the structure in separate turns.',
    )
  }
}
